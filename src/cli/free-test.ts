// src/cli/free-test.ts — Benchmarks every free model declared in opencode.jsonc and can set a new default
// (ported from the former scripts/free-test.py). Free models cost 0, so ranking is quality desc, then latency asc.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../core/paths";
import { FetchLike, USER_AGENT, pad, readJson, readKey, sleep, writeJson } from "./common";
import { parseJsonc, setTopLevelString } from "./jsonc";

const EUR_PER_USD = 0.92;
const INR_PER_USD = 83.0;

/** Expected quality (0-1) by model family; a proxy, since the models are free. */
export const QUALITY_BASELINE: Record<string, number> = {
  "gemini-2.5-flash": 0.96,
  "gemini-2.5-flash-lite": 0.88,
  "gemini-flash-latest": 0.96,
  "gemini-flash-lite-latest": 0.88,
  "glm-4.7-flash": 0.85,
  "codestral-latest": 0.9,
  "mistral-code-latest": 0.85,
  "Qwen/Qwen3-Coder-480B-A35B-Instruct:cheapest": 0.8,
  "deepseek-ai/DeepSeek-V4-Flash:cheapest": 0.92,
  "qwen/qwen3.8-27b": 0.82,
  "openai/gpt-oss-120b": 0.78,
  "openai/gpt-oss-20b": 0.65,
  "qwen/qwen3.6-27b": 0.8,
  "openrouter/free": 0.75,
};

/** Key file per provider when it is not simply `.<provider>-key`. */
const KEY_FILE: Record<string, string> = { google: ".gemini-key", huggingface: ".hf-key" };

export interface FreeModel {
  alias: string;
  name: string;
  provider: string;
  model_id: string;
  limit: Record<string, unknown>;
  quality_baseline: number;
}

export interface TestResult {
  alias: string;
  name: string;
  provider: string;
  model_id: string;
  limit: Record<string, unknown>;
  status: string;
  latency_ms: number | null;
  cost_eur: number;
  cost_inr: number;
  quality_score: number;
  error: string | null;
}

/** Free = the model's display name contains "(FREE", or any model under openrouter (auto-router). */
export function extractFreeModels(config: any): FreeModel[] {
  const found: FreeModel[] = [];
  for (const [provider, prov] of Object.entries<any>(config?.provider ?? {})) {
    for (const [id, meta] of Object.entries<any>(prov?.models ?? {})) {
      const name = meta && typeof meta === "object" ? (meta.name ?? id) : String(meta);
      const free = provider === "openrouter" || String(name).includes("(FREE");
      if (!free) continue;
      found.push({
        alias: id,
        name,
        provider,
        model_id: id,
        limit: meta && typeof meta === "object" ? (meta.limit ?? {}) : {},
        quality_baseline: QUALITY_BASELINE[id] ?? 0.7,
      });
    }
  }
  return found;
}

export interface FreeTestDeps {
  dir: string;
  fetchImpl: FetchLike;
  /** Pauses between same-provider / inter-provider requests. */
  delays: { sameProviderMs: number; betweenProvidersMs: number };
  out: (line: string) => void;
  err: (line: string) => void;
}

export function defaultFreeTestDeps(dir = configDir()): FreeTestDeps {
  return {
    dir,
    fetchImpl: fetch,
    delays: { sameProviderMs: 1500, betweenProvidersMs: 500 },
    out: (l) => console.log(l),
    err: (l) => process.stderr.write(l + "\n"),
  };
}

/** One micro-query (max 5 tokens) against one model. */
export async function testModel(
  model: FreeModel,
  config: any,
  deps: Pick<FreeTestDeps, "dir" | "fetchImpl">
): Promise<TestResult> {
  const provider = model.provider;
  const prov = config?.provider?.[provider] ?? {};
  const result: TestResult = {
    alias: model.alias,
    name: model.name,
    provider,
    model_id: model.model_id,
    limit: model.limit,
    status: "error",
    latency_ms: null,
    cost_eur: 0,
    cost_inr: 0,
    quality_score: model.quality_baseline,
    error: null,
  };

  const key = readKey(deps.dir, KEY_FILE[provider] ?? `.${provider}-key`);
  if (!key) {
    result.error = "no_api_key";
    return result;
  }

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  if (provider === "google") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model.model_id}:generateContent`;
    headers = {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
      "User-Agent": USER_AGENT,
    };
    body = { contents: [{ parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 5 } };
  } else {
    let id = model.model_id;
    // HuggingFace router wants the ":cheapest" policy suffix.
    if (provider === "huggingface" && !id.includes(":")) id = `${id}:cheapest`;
    const base = String(prov?.options?.baseURL ?? "").replace(/\/$/, "");
    url = `${base}/chat/completions`;
    headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    body = {
      model: id,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 5,
      temperature: 0,
    };
  }

  const t0 = Date.now();
  try {
    const res = await deps.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      result.status = "ok";
      result.latency_ms = Date.now() - t0;
    } else {
      result.status = res.status === 429 ? "rate_limited" : "error";
      result.error = `HTTP ${res.status}`;
    }
  } catch (e) {
    result.error = String((e as Error)?.message ?? e).slice(0, 100);
  }
  return result;
}

export async function runTests(
  models: FreeModel[],
  config: any,
  deps: FreeTestDeps
): Promise<TestResult[]> {
  const byProvider = new Map<string, FreeModel[]>();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  const results: TestResult[] = [];
  for (const list of byProvider.values()) {
    for (const [i, m] of list.entries()) {
      results.push(await testModel(m, config, deps));
      if (i < list.length - 1) await sleep(deps.delays.sameProviderMs);
    }
    await sleep(deps.delays.betweenProvidersMs);
  }
  return results;
}

export function sortResults(results: TestResult[]): TestResult[] {
  return [...results].sort(
    (a, b) => b.quality_score - a.quality_score || (a.latency_ms || 9999) - (b.latency_ms || 9999)
  );
}

export function generateReport(results: TestResult[], now = new Date()) {
  const sorted = sortResults(results);
  return {
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    total_models: sorted.length,
    exchange_rates: { eur_per_usd: EUR_PER_USD, inr_per_usd: INR_PER_USD },
    sorted_by: "quality_score (desc), then latency_ms (asc)",
    results: sorted,
  };
}

const HELP = `free-test — test and benchmark all free AI models

Usage: tollfree free-test <command>

  test     Latency + quality test on ALL free models (writes the report)
           Respects rate limits; can take 30s+ for a provider with many models.
  report   Show the last report (no API calls)
  use <m>  Set <m> as the default model in opencode.jsonc
  list     List the free models detected in the current config

Exchange rates used: 1 USD = ${EUR_PER_USD.toFixed(2)} EUR, 1 USD = ${INR_PER_USD.toFixed(2)} INR (free models always cost 0)
`;

function loadConfig(dir: string): { path: string; text: string; config: any } | undefined {
  const path = join(dir, "opencode.jsonc");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  return { path, text, config: parseJsonc(text) };
}

const row = (cells: Array<[string | number, number]>) => cells.map(([v, w]) => pad(v, w)).join(" ");

export async function runFreeTest(
  argv: string[],
  deps: FreeTestDeps = defaultFreeTestDeps()
): Promise<number> {
  const cmd = (argv[0] ?? "").toLowerCase().trim();
  const reportPath = join(deps.dir, "free-test-report.json");

  if (cmd === "" || ["help", "-h", "--help"].includes(cmd)) {
    deps.out(HELP);
    return 0;
  }

  if (["test", "-t", "report", "-r", "use", "-u", "list", "-l"].includes(cmd) === false) {
    deps.err(`Unknown command: ${cmd}`);
    deps.out(HELP);
    return 1;
  }

  if (cmd === "report" || cmd === "-r") {
    const report = readJson<ReturnType<typeof generateReport>>(reportPath);
    if (!report) {
      deps.err("No report found. Run 'tollfree free-test test' first.");
      return 1;
    }
    deps.out(`\n=== free-test report (generated: ${report.generated_at}) ===`);
    deps.out(`Total models tested: ${report.total_models}`);
    deps.out(`Sorted by: ${report.sorted_by}\n`);
    deps.out(
      row([
        ["#", 4],
        ["MODEL", 42],
        ["PROVIDER", 12],
        ["STATUS", 15],
        ["LAT(ms)", 10],
        ["QUAL", 6],
      ])
    );
    deps.out("-".repeat(95));
    report.results.forEach((m, i) => {
      const err = m.error ? ` (${m.error})` : "";
      deps.out(
        row([
          [i + 1, 4],
          [m.alias.slice(0, 40), 42],
          [m.provider, 12],
          [m.status, 15],
          [m.latency_ms ?? "—", 10],
          [m.quality_score.toFixed(2), 6],
        ]) + err
      );
    });
    deps.out("-".repeat(95));
    const best = report.results.find((m) => m.status === "ok");
    if (best) {
      deps.out(`\n* BEST (quality/price): ${best.alias} (${best.provider})`);
      deps.out(`    quality=${best.quality_score}, latency=${best.latency_ms}ms, cost=€0 (FREE)`);
      deps.out(`\n    -> Run: tollfree free-test use ${best.alias}`);
    }
    deps.out(`\nFull JSON report: ${reportPath}`);
    return 0;
  }

  const loaded = loadConfig(deps.dir);
  if (!loaded) {
    deps.err(`No opencode.jsonc found in ${deps.dir}`);
    return 1;
  }
  const free = extractFreeModels(loaded.config);

  if (cmd === "list" || cmd === "-l") {
    deps.out(`\n=== Free Models Detected (${free.length} total) ===\n`);
    const groups = new Map<string, FreeModel[]>();
    for (const m of free) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
    for (const [provider, models] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      deps.out(`  [${provider}]`);
      for (const m of models) {
        const l = m.limit as Record<string, unknown>;
        const limits = Object.keys(l).length
          ? ` (ctx=${l.context ?? "—"}, out=${l.output ?? "—"})`
          : "";
        deps.out(`    - ${m.alias}${limits}`);
        deps.out(`      name: ${m.name}`);
        deps.out(`      quality: ${m.quality_baseline}`);
      }
      deps.out("");
    }
    return 0;
  }

  if (cmd === "use" || cmd === "-u") {
    const alias = argv[1];
    if (!alias) {
      deps.err(
        "Usage: tollfree free-test use <model-alias>\n\nExample: tollfree free-test use gemini-2.5-flash"
      );
      return 1;
    }
    const match = free.find((m) => m.alias === alias);
    if (!match) {
      deps.out(`Model '${alias}' not found in free models.`);
      deps.out("Available free models:");
      for (const m of free) deps.out(`  ${m.alias} (${m.provider})`);
      return 1;
    }
    const updated = setTopLevelString(loaded.text, "model", alias);
    if (updated === undefined) {
      deps.err("Could not update config. Make sure a top-level 'model' field exists.");
      return 1;
    }
    writeFileSync(loaded.path, updated, "utf8");
    deps.out(`Default model updated to: ${alias} (${match.name})`);
    deps.out("\nFree models available (sorted by quality/price):");
    for (const m of [...free].sort((a, b) => b.quality_baseline - a.quality_baseline)) {
      deps.out(`  ${m.alias} (${m.provider}) - quality: ${m.quality_baseline}`);
    }
    return 0;
  }

  // test
  const providers = new Set(free.map((m) => m.provider));
  deps.out(`Found ${free.length} free models across ${providers.size} providers:`);
  for (const m of free) deps.out(`  - ${m.alias} (${m.provider}) -> ${m.name}`);
  deps.out("\nTesting (respecting rate limits)...");
  const results = await runTests(free, loaded.config, deps);
  const report = generateReport(results);
  writeJson(reportPath, report);
  deps.out(`Report saved to: ${reportPath}`);
  deps.out("\n" + "=".repeat(100));
  deps.out(
    row([
      ["MODEL", 40],
      ["PROVIDER", 12],
      ["STATUS", 15],
      ["LAT(ms)", 10],
      ["QUAL", 6],
      ["EUR", 8],
      ["INR", 8],
    ])
  );
  deps.out("-".repeat(100));
  for (const m of sortResults(results)) {
    deps.out(
      row([
        [m.alias, 40],
        [m.provider, 12],
        [m.status, 15],
        [m.latency_ms ?? "—", 10],
        [m.quality_score.toFixed(2), 6],
        [m.cost_eur.toFixed(2), 8],
        [m.cost_inr.toFixed(2), 8],
      ])
    );
  }
  deps.out("=".repeat(100));
  deps.out(`\nFull report: ${reportPath}`);
  deps.out("\nTo set a new default: tollfree free-test use <model-alias>");
  return 0;
}
