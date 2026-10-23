import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { computeStatistics, formatEntry, matchEntry, parseTime, runAuditLog } from "./audit-log";
import { extractMeta, runProbe } from "./probe";
import { runQuota } from "./quota";
import { RouteDeps, Status, computeEv, effectiveQuality, runRoute } from "./route";

const tmp = () => mkdtempSync(join(tmpdir(), "tollfree-cli-"));

function routeDeps(dir: string, status: Status) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: RouteDeps = {
    dir,
    loadStatus: async () => status,
    refresh: async () => undefined,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err };
}

const HEALTHY: Status = {
  models: { "worker-codestral": "ok", "worker-groq": "ok", "worker-novita": "rate_limited" },
  latencies_ms: { "worker-codestral": 800, "worker-groq": 300, "worker-novita": 500 },
  models_meta: { "worker-novita": { context: 256_000 } },
};

describe("route", () => {
  test("effectiveQuality blends baseline with feedback (baseline = 4 priors)", () => {
    expect(effectiveQuality("worker-groq", {})).toBeCloseTo(0.82);
    // 4 failures on top of 4 priors -> halfway between 0.82 and 0
    expect(effectiveQuality("worker-groq", { "worker-groq": { ok: 0, fail: 4 } })).toBeCloseTo(
      0.41
    );
    expect(effectiveQuality("unknown-worker", {})).toBeCloseTo(0.8);
  });

  test("an integrated worker beats a slow external one; rate-limited is penalized", () => {
    const r = computeEv("code", HEALTHY, {});
    expect(r[0].name).toBe("worker-opencode");
    const novita = r.find((c) => c.name === "worker-novita")!;
    expect(novita.avail).toBe(0.2);
  });

  test("a failing worker drops in the ranking after feedback", () => {
    const failing = { "worker-groq": { ok: 0, fail: 40 } };
    const groq = (usage: typeof failing | Record<string, never>) =>
      computeEv("quick", HEALTHY, usage).find((c) => c.name === "worker-groq")!;
    expect(groq(failing).ev).toBeLessThan(groq({}).ev / 5);
    const ranked = computeEv("quick", HEALTHY, failing).map((c) => c.name);
    expect(ranked[ranked.length - 1]).toBe("worker-groq");
  });

  test("long tasks penalize workers with too little context", () => {
    const small: Status = {
      ...HEALTHY,
      models_meta: { "worker-novita": { context: 32_000 } },
      models: { "worker-novita": "ok" },
    };
    const big: Status = { ...HEALTHY, models: { "worker-novita": "ok" } };
    const penalized = computeEv("long", small, {}).find((c) => c.name === "worker-novita")!;
    const normal = computeEv("long", big, {}).find((c) => c.name === "worker-novita")!;
    expect(penalized.avail).toBeCloseTo(normal.avail * 0.25);
  });

  test("route <type> prints the parseable line and --next picks the runner-up", async () => {
    const { deps, out } = routeDeps(tmp(), HEALTHY);
    expect(await runRoute(["code"], deps)).toBe(0);
    const [worker, model, , ev, , , , mode] = out[0].split("|");
    expect(worker).toBe("worker-opencode");
    expect(model).toBe("opencode/deepseek-v4-flash");
    expect(ev).toMatch(/^EV=\d+\.\d{3}$/);
    expect(mode).toBe("mode=FREE");

    const second = routeDeps(tmp(), HEALTHY);
    await runRoute(["code", "--next"], second.deps);
    expect(second.out[0].split("|")[0]).not.toBe("worker-opencode");
  });

  test("--pro prefers paid workers; unknown type is an error; --next past the end exits 2", async () => {
    const pro = routeDeps(tmp(), HEALTHY);
    await runRoute(["code", "--pro"], pro.deps);
    expect(pro.out[0]).toContain("mode=PRO");

    const bad = routeDeps(tmp(), HEALTHY);
    expect(await runRoute(["nope"], bad.deps)).toBe(1);
    expect(bad.err[0]).toContain("Type inconnu 'nope'");

    const past = routeDeps(tmp(), HEALTHY);
    expect(await runRoute(["code", "--next=99"], past.deps)).toBe(2);
  });

  test("record persists feedback to route-usage.json", async () => {
    const dir = tmp();
    const { deps, out } = routeDeps(dir, HEALTHY);
    await runRoute(["record", "worker-groq", "fail"], deps);
    await runRoute(["record", "worker-groq", "success"], deps);
    expect(out[1]).toBe("recorded worker-groq success (ok=1, fail=1)");
    expect(JSON.parse(readFileSync(join(dir, "route-usage.json"), "utf8"))["worker-groq"]).toEqual({
      ok: 1,
      fail: 1,
    });
    expect(await runRoute(["record", "ghost", "fail"], routeDeps(dir, HEALTHY).deps)).toBe(1);
  });

  test("list and report print one row per worker / task type", async () => {
    const list = routeDeps(tmp(), HEALTHY);
    await runRoute(["list"], list.deps);
    expect(list.out.length).toBe(1 + 11);
    const report = routeDeps(tmp(), HEALTHY);
    await runRoute(["report"], report.deps);
    expect(report.out.length).toBe(6);
  });
});

describe("probe", () => {
  const fakeFetch = (statuses: Record<string, number>) => async (url: string) => {
    if (url.includes("models.dev")) {
      return new Response(
        JSON.stringify({
          groq: {
            models: {
              "qwen/qwen3.8-27b": {
                limit: { context: 131042, output: 8192 },
                cost: { input: 0, output: 0 },
              },
            },
          },
        }),
        { status: 200 }
      );
    }
    const host = Object.keys(statuses).find((h) => url.includes(h));
    return new Response("{}", { status: host ? statuses[host] : 500 });
  };

  test("maps HTTP statuses, writes free-models.json, skips cloudflare without credentials", async () => {
    const dir = tmp();
    const lines: string[] = [];
    const report = await runProbe({
      dir,
      delayMs: 0,
      log: (l) => lines.push(l),
      fetchImpl: fakeFetch({
        "api.groq.com": 200,
        "api.z.ai": 429,
        "openrouter.ai": 401,
        "localhost:11434": 200,
      }),
    });
    expect(report.models["worker-groq"]).toBe("ok");
    expect(report.models["worker-zhipu"]).toBe("rate_limited");
    expect(report.models["worker-codestral"]).toBe("error");
    expect(report.models["worker-ollama"]).toBe("ok");
    expect(report.models["worker-cloudflare"]).toBe("skipped");
    expect(report.models_meta["worker-groq"].context).toBe(131042);
    expect(
      JSON.parse(readFileSync(join(dir, "free-models.json"), "utf8")).models["worker-groq"]
    ).toBe("ok");
    expect(lines.some((l) => l.includes("[OK] worker-groq"))).toBe(true);
    expect(lines.some((l) => l.includes("[SKIP] worker-cloudflare"))).toBe(true);
  });

  test("network failures become 'error' instead of throwing", async () => {
    const report = await runProbe({
      dir: tmp(),
      delayMs: 0,
      log: () => undefined,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(report.models["worker-groq"]).toBe("error");
    expect(report.models_meta).toEqual({});
  });

  test("extractMeta ignores malformed payloads", () => {
    expect(extractMeta(null)).toEqual({});
    expect(extractMeta({ groq: { models: {} } })).toEqual({});
  });
});

describe("audit-log", () => {
  const entries = [
    {
      ts: "2026-10-01T10:00:00Z",
      event: "tool.execute.before",
      tool: "bash",
      args: { command: "ls" },
    },
    { ts: "2026-10-01T10:00:01Z", event: "tool.execute.after", tool: "bash", success: true },
    {
      ts: "2026-10-01T10:05:00Z",
      event: "tool.execute.after",
      tool: "edit",
      error: "boom",
      sensitive: true,
    },
    {
      ts: "2026-10-01T10:06:00Z",
      event: "agent.invoked",
      agent: "builder",
      model: "m",
      provider: "groq",
      task: "fix",
    },
  ];

  test("filters", () => {
    expect(entries.filter((e) => matchEntry(e, { tool: "bash" })).length).toBe(2);
    expect(entries.filter((e) => matchEntry(e, { errors: true })).length).toBe(1);
    expect(entries.filter((e) => matchEntry(e, { sensitive: true })).length).toBe(1);
    expect(
      entries.filter((e) => matchEntry(e, { since: new Date("2026-10-01T10:04:00Z") })).length
    ).toBe(2);
  });

  test("parseTime handles HH:MM and full timestamps", () => {
    const today = new Date(2026, 9, 1, 12, 0);
    expect(parseTime("08:30", today)?.getHours()).toBe(8);
    expect(parseTime("2026-09-30 23:15", today)?.getDate()).toBe(30);
    expect(parseTime("garbage", today)).toBeUndefined();
  });

  test("formatEntry and statistics", () => {
    expect(formatEntry(entries[3])).toContain("[AGT] builder (m) via groq");
    expect(formatEntry(entries[1])).toContain("[OK]");
    const s = computeStatistics(entries);
    expect(s.total).toBe(4);
    expect(s.errors).toBe(1);
    expect(s.success).toBe(1);
    expect(s.by_tool.bash).toBe(2);
  });

  test("reads a day file, honors --limit, reports missing logs", async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "audit-2026-10-01.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n"
    );
    const out: string[] = [];
    await runAuditLog(["--date", "2026-10-01", "--limit", "2"], dir, (l) => out.push(l));
    expect(out.length).toBe(2);

    const stats: string[] = [];
    await runAuditLog(["--date", "2026-10-01", "--statistics"], dir, (l) => stats.push(l));
    expect(stats[0]).toBe("=== Audit Log Statistics ===");
    expect(stats[1]).toBe("Total entries: 4");

    const none: string[] = [];
    await runAuditLog(["--date", "1999-01-01"], dir, (l) => none.push(l));
    expect(none[0]).toContain("No log files found");
  });
});

describe("quota", () => {
  test("prints the dashboard from free-models.json without network probes", async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "free-models.json"),
      JSON.stringify({
        updated: Math.floor(Date.now() / 1000),
        models: { "worker-groq": "ok", "worker-zhipu": "rate_limited" },
      })
    );
    const out: string[] = [];
    const saved = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmp(); // no opencode.db here
    try {
      expect(await runQuota(dir, (l) => out.push(l))).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
    const text = out.join("\n");
    expect(text).toContain("Mode actuel");
    expect(text).toContain("Groq");
    expect(text).toContain("Utilise Groq en ce moment");
    expect(text).toContain("en pause (quota atteint)");
  });
});
