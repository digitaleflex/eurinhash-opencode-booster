import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DirectDeps,
  PROVIDERS,
  ProviderError,
  ProviderState,
  callProvider,
  detectProvider,
  extractContent,
  humanizeError,
  runDirect,
} from "./direct";
import {
  extractFreeModels,
  generateReport,
  runFreeTest,
  sortResults,
  testModel,
} from "./free-test";
import { parseJsonc, setTopLevelString, stripJsonc } from "./jsonc";
import { freeModelsOf, runModelsFree } from "./models-free";

const tmp = () => mkdtempSync(join(tmpdir(), "tollfree-direct-"));
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

type Reply = { status: number; body?: unknown } | Error;

function setup(
  replies: Record<string, Reply | Reply[]>,
  keys: string[] = ["groq", "zhipu", "mistral"]
) {
  const dir = tmp();
  for (const k of keys) writeFileSync(join(dir, PROVIDERS[k].keyFile), `key-${k}\n`);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = T0;
  const deps: DirectDeps = {
    dir,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init as RequestInit });
      const host = Object.keys(replies).find((h) => url.includes(h));
      if (!host) throw new Error("fetch failed");
      const entry = replies[host];
      const r = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    },
  };
  return { deps, calls, out, err, dir, advance: (ms: number) => (clock += ms) };
}

const OK = (content: string): Reply => ({
  status: 200,
  body: { choices: [{ message: { content } }] },
});

describe("direct: helpers", () => {
  test("detectProvider by known model and by provider prefix", () => {
    expect(detectProvider("qwen/qwen3.8-27b")).toBe("groq");
    expect(detectProvider("gemini-2.5-flash")).toBe("google");
    expect(detectProvider("zenmux/anything")).toBe("zenmux");
    expect(detectProvider("mystery")).toBeUndefined();
  });

  test("extractContent handles OpenAI, text, Gemini and unknown shapes", () => {
    expect(extractContent({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(extractContent({ choices: [{ text: "t" }] })).toBe("t");
    expect(extractContent({ candidates: [{ content: { parts: [{ text: "g" }] } }] })).toBe("g");
    expect(extractContent({ weird: 1 })).toBe('{"weird":1}');
  });

  test("humanizeError maps statuses and local conditions", () => {
    expect(humanizeError(new ProviderError("x", 429))).toContain("Rate limited");
    expect(humanizeError(new ProviderError("x", 401))).toContain("Clé API refusée");
    expect(humanizeError(new ProviderError("x", 404))).toContain("Modèle introuvable");
    expect(humanizeError(new Error("The operation timed out"))).toContain("Délai dépassé");
    expect(humanizeError(new Error("Circuit breaker OPEN pour groq"))).toContain("circuit ouvert");
    expect(humanizeError(new Error("Quota local dépassé pour groq/x"))).toContain("Quota du jour");
    expect(humanizeError(new Error("Cle groq introuvable"))).toContain("non configurée");
    expect(humanizeError(new Error("fetch failed"))).toContain("Réseau");
    expect(humanizeError(new Error("???"))).toContain("inattendue");
  });
});

describe("direct: state and calls", () => {
  const opts = { maxTokens: 10, temperature: 0 };

  test("a successful call counts usage and keeps the circuit CLOSED", async () => {
    const { deps, dir } = setup({ "api.groq.com": OK("pong") });
    const res = await callProvider(
      "groq",
      "qwen/qwen3.8-27b",
      [{ role: "user", content: "ping" }],
      opts,
      deps
    );
    expect(extractContent(res)).toBe("pong");
    const state = new ProviderState(dir, deps.now);
    expect(state.usageToday("groq", "qwen/qwen3.8-27b")).toBe(1);
    expect(state.loadCircuit().groq.state).toBe("CLOSED");
  });

  test("three failures open the circuit; it half-opens after 60 s", async () => {
    const { deps, dir, advance } = setup({ "api.groq.com": { status: 500 } });
    const call = () => callProvider("groq", "m", [{ role: "user", content: "x" }], opts, deps);
    for (let i = 0; i < 3; i++) await expect(call()).rejects.toThrow("HTTP 500");
    const state = new ProviderState(dir, deps.now);
    expect(state.loadCircuit().groq.state).toBe("OPEN");
    await expect(call()).rejects.toThrow(/Circuit breaker OPEN/);
    advance(61_000);
    expect(state.checkCircuit("groq")).toBe(true);
    expect(state.loadCircuit().groq.state).toBe("HALF_OPEN");
  });

  test("the local daily quota blocks further calls and resets next day", async () => {
    const { deps, dir, advance } = setup({ "api.z.ai": OK("ok") });
    const state = new ProviderState(dir, deps.now);
    for (let i = 0; i < PROVIDERS.zhipu.quota; i++) state.recordUsage("zhipu", "glm-4.7-flash");
    await expect(
      callProvider("zhipu", "glm-4.7-flash", [{ role: "user", content: "x" }], opts, deps)
    ).rejects.toThrow(/Quota local dépassé/);
    advance(24 * 3600 * 1000);
    expect(state.checkQuota("zhipu", "glm-4.7-flash")).toBe(true);
  });

  test("a missing key fails fast without a network call", async () => {
    const { deps, calls } = setup({}, []);
    await expect(
      callProvider("groq", "m", [{ role: "user", content: "x" }], opts, deps)
    ).rejects.toThrow(/Cle groq introuvable/);
    expect(calls.length).toBe(0);
  });

  test("Google uses its native request shape with the key in a header, not the URL", async () => {
    const { deps, calls } = setup(
      {
        generativelanguage: {
          status: 200,
          body: { candidates: [{ content: { parts: [{ text: "g" }] } }] },
        },
      },
      ["google"]
    );
    const res = await callProvider(
      "google",
      "gemini-2.5-flash",
      [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      opts,
      deps
    );
    expect(extractContent(res)).toBe("g");
    expect(calls[0].url).toContain("gemini-2.5-flash:generateContent");
    expect(calls[0].url).not.toContain("key-google");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("key-google");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("be brief");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });
});

describe("direct: command", () => {
  test("falls back to the next provider and prints the answer", async () => {
    const { deps, out, err } = setup({
      "api.groq.com": { status: 429 },
      "api.z.ai": OK("from zhipu"),
    });
    expect(await runDirect(["hello", "--task-type", "chat"], deps)).toBe(0);
    expect(out).toEqual(["[zhipu/glm-4.7-flash] from zhipu"]);
    expect(err[0]).toContain("[fallback] groq failed");
  });

  test("--progress shows the chain and the fallback path", async () => {
    const { deps, out } = setup({ "api.groq.com": { status: 429 }, "api.z.ai": OK("done") });
    expect(
      await runDirect(["hello", "--progress", "--no-color", "--task-type", "chat"], deps)
    ).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Rate limited (429)");
    expect(text).toContain("Routé via fallback (groq → zhipu)");
    expect(text).toContain("done");
  });

  test("all providers failing returns 1; --json prints the raw response", async () => {
    const fail = setup({
      "api.groq.com": { status: 500 },
      "api.z.ai": { status: 500 },
      "api.mistral.ai": { status: 500 },
    });
    expect(await runDirect(["hello"], fail.deps)).toBe(1);
    expect(fail.err.at(-1)).toContain("Erreur: All providers failed");

    const ok = setup({ "api.groq.com": OK("raw") });
    expect(await runDirect(["hello", "--json"], ok.deps)).toBe(0);
    const parsed = JSON.parse(ok.out.join("\n"));
    expect(parsed._provider_used).toBe("groq");
    expect(extractContent(parsed)).toBe("raw");
  });

  test("--provider and --model route explicitly; unknown ones are errors", async () => {
    const a = setup({ "api.z.ai": OK("z") });
    expect(await runDirect(["hi", "-p", "zhipu"], a.deps)).toBe(0);
    expect(a.out[0]).toBe("[zhipu/glm-4.7-flash] z");

    const b = setup({ "api.groq.com": OK("g") });
    expect(await runDirect(["hi", "-m", "openai/gpt-oss-20b"], b.deps)).toBe(0);
    expect(b.out[0]).toBe("[groq/openai/gpt-oss-20b] g");

    expect(await runDirect(["hi", "-p", "nope"], setup({}).deps)).toBe(1);
    expect(await runDirect(["hi", "-m", "mystery"], setup({}).deps)).toBe(1);
  });

  test("--status, --list-providers and the resets", async () => {
    const { deps, out, dir } = setup({ "api.groq.com": OK("x") });
    await runDirect(["hi"], deps);
    out.length = 0;
    await runDirect(["--status"], deps);
    expect(out.join("\n")).toContain("groq/qwen/qwen3.8-27b: 1/50");
    out.length = 0;
    await runDirect(["--list-providers"], deps);
    expect(out.join("\n")).toContain("groq: [OK] OK");
    expect(out.join("\n")).toContain("together: [NO] NO KEY");
    await runDirect(["--reset-quota"], deps);
    expect(new ProviderState(dir, deps.now).loadUsage()).toEqual({});
  });

  test("--batch runs every line once and writes the JSON report", async () => {
    const { deps, dir } = setup({ "api.groq.com": [OK("one"), OK("two")] });
    const file = join(dir, "prompts.txt");
    const outFile = join(dir, "out.json");
    writeFileSync(file, "first\n\nsecond\n");
    expect(await runDirect(["--batch", file, "--output", outFile], deps)).toBe(0);
    const data = JSON.parse(readFileSync(outFile, "utf8"));
    expect(data.prompts_count).toBe(2);
    expect(data.results.length).toBe(2);
    expect(data.results.map((r: any) => extractContent(r))).toEqual(["one", "two"]);
    expect(await runDirect(["--batch", join(dir, "missing.txt")], deps)).toBe(1);
  });
});

describe("jsonc", () => {
  const sample = `{
  // top-level model
  "model": "old/model", /* inline */
  "small_model": "keep/me",
  "provider": { "x": { "model": "nested", "models": { "a": {}, }, }, },
}`;

  test("parses comments and trailing commas but keeps strings intact", () => {
    const cfg = parseJsonc(sample);
    expect(cfg.model).toBe("old/model");
    expect(cfg.provider.x.models).toEqual({ a: {} });
    expect(parseJsonc('{"u": "http://example.com/a//b", "c": "/* not a comment */"}')).toEqual({
      u: "http://example.com/a//b",
      c: "/* not a comment */",
    });
    expect(stripJsonc('{"a": [1,2,],}')).not.toContain(",]");
  });

  test("setTopLevelString edits only the top-level key and preserves comments", () => {
    const next = setTopLevelString(sample, "model", "new/model")!;
    expect(next).toContain('"model": "new/model"');
    expect(next).toContain("// top-level model");
    expect(next).toContain('"small_model": "keep/me"');
    expect(next).toContain('"model": "nested"');
    expect(setTopLevelString('{ "a": 1 }', "model", "x")).toBeUndefined();
    // a commented-out "model" must not be matched
    expect(setTopLevelString('{ // "model": "ghost"\n "model": "real" }', "model", "x")).toContain(
      '"model": "x"'
    );
  });
});

describe("free-test", () => {
  const config = parseJsonc(`{
    "model": "google/gemini-2.5-flash",
    "provider": {
      "google": { "models": { "gemini-2.5-flash": { "name": "Gemini 2.5 Flash (FREE)", "limit": { "context": 1048576 } }, "gemini-pro": { "name": "Pro" } } },
      "groq": { "options": { "baseURL": "https://api.groq.com/openai/v1" }, "models": { "qwen/qwen3.8-27b": { "name": "Qwen (FREE, 27b)" } } },
      "openrouter": { "options": { "baseURL": "https://openrouter.ai/api/v1" }, "models": { "openrouter/free": { "name": "Auto" } } }
    }
  }`);

  test("extractFreeModels keeps (FREE...) names and every openrouter model", () => {
    const aliases = extractFreeModels(config).map((m) => m.alias);
    expect(aliases.sort()).toEqual(["gemini-2.5-flash", "openrouter/free", "qwen/qwen3.8-27b"]);
  });

  test("testModel: google reads .gemini-key, openai-compatible uses baseURL, missing key reported", async () => {
    const { deps, calls } = setup(
      { generativelanguage: { status: 200 }, "api.groq.com": { status: 429 } },
      []
    );
    writeFileSync(join(deps.dir, ".gemini-key"), "g-key");
    writeFileSync(join(deps.dir, ".groq-key"), "q-key");
    const free = extractFreeModels(config);
    const google = await testModel(
      free.find((m) => m.provider === "google")!,
      config,
      deps
    );
    expect(google.status).toBe("ok");
    expect(google.latency_ms).not.toBeNull();
    expect(calls[0].url).not.toContain("g-key");

    const groq = await testModel(
      free.find((m) => m.provider === "groq")!,
      config,
      deps
    );
    expect(groq.status).toBe("rate_limited");
    expect(groq.error).toBe("HTTP 429");
    expect(calls[1].url).toBe("https://api.groq.com/openai/v1/chat/completions");

    const router = await testModel(
      free.find((m) => m.provider === "openrouter")!,
      config,
      deps
    );
    expect(router.error).toBe("no_api_key");
  });

  test("report ordering: quality desc, then latency asc", () => {
    const base = {
      name: "n",
      provider: "p",
      model_id: "m",
      limit: {},
      status: "ok",
      cost_eur: 0,
      cost_inr: 0,
      error: null,
    };
    const sorted = sortResults([
      { ...base, alias: "slow", quality_score: 0.9, latency_ms: 900 },
      { ...base, alias: "best", quality_score: 0.96, latency_ms: 500 },
      { ...base, alias: "fast", quality_score: 0.9, latency_ms: 100 },
    ]);
    expect(sorted.map((r) => r.alias)).toEqual(["best", "fast", "slow"]);
    expect(generateReport(sorted, new Date("2026-10-01T10:00:00.123Z")).generated_at).toBe(
      "2026-10-01T10:00:00Z"
    );
  });

  test("test → report → use end to end on a temp config dir", async () => {
    const { deps, dir, out } = setup(
      {
        generativelanguage: { status: 200 },
        "api.groq.com": { status: 200 },
        "openrouter.ai": { status: 200 },
      },
      []
    );
    for (const k of [".gemini-key", ".groq-key", ".openrouter-key"])
      writeFileSync(join(dir, k), "k");
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{\n  // my default\n  "model": "old/model",\n  "provider": ${JSON.stringify(config.provider)}\n}\n`
    );
    const fdeps = { ...deps, delays: { sameProviderMs: 0, betweenProvidersMs: 0 } };
    expect(await runFreeTest(["test"], fdeps)).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "free-test-report.json"), "utf8"));
    expect(report.total_models).toBe(3);
    expect(report.results[0].alias).toBe("gemini-2.5-flash");

    out.length = 0;
    expect(await runFreeTest(["report"], fdeps)).toBe(0);
    expect(out.join("\n")).toContain("* BEST (quality/price): gemini-2.5-flash (google)");

    expect(await runFreeTest(["use", "qwen/qwen3.8-27b"], fdeps)).toBe(0);
    const text = readFileSync(join(dir, "opencode.jsonc"), "utf8");
    expect(text).toContain('"model": "qwen/qwen3.8-27b"');
    expect(text).toContain("// my default");
    expect(await runFreeTest(["use", "ghost"], fdeps)).toBe(1);
    expect(await runFreeTest(["bogus"], fdeps)).toBe(1);
  });
});

describe("models-free", () => {
  const api = {
    groq: {
      models: {
        "qwen/qwen3.8-27b": { name: "Qwen", cost: { input: 0 }, limit: { context: 131042 } },
        "whisper-large": { name: "Whisper", cost: { input: 0 } },
        "paid-model": { name: "Paid", cost: { input: 1 } },
      },
    },
  };

  test("keeps only input cost 0, optionally code-oriented", () => {
    expect(freeModelsOf(api.groq, false).map((m) => m.id)).toEqual([
      "qwen/qwen3.8-27b",
      "whisper-large",
    ]);
    expect(freeModelsOf(api.groq, true).map((m) => m.id)).toEqual(["qwen/qwen3.8-27b"]);
  });

  test("prints a total and flags providers missing from models.dev", async () => {
    const out: string[] = [];
    const fetchImpl = async () => new Response(JSON.stringify({ providers: api }), { status: 200 });
    expect(await runModelsFree(["--code"], fetchImpl, (l) => out.push(l))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("[groq] 1 modèle(s) gratuit(s)");
    expect(text).toContain("[openrouter] ABSENT de models.dev");
    expect(text).toContain("Total : 1 modèle(s) gratuit(s)");
  });
});
