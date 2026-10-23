// src/cli/probe.ts — Probes the free workers and writes free-models.json (port of scripts/free-probe.py).
// One tiny call per worker (~15 tokens). Never probes HuggingFace (paid credit).

import { join } from "node:path";
import { configDir } from "../core/paths";
import {
  FetchLike,
  USER_AGENT,
  PostResult,
  pad,
  postJson,
  readJson,
  readKey,
  sleep,
  writeJson,
} from "./common";

type Json = Record<string, unknown>;

interface ProbeDef {
  worker: string;
  /** Secret file read from the config dir; undefined = no key needed. */
  keyFile?: string;
  timeoutMs?: number;
  /** Pause after this probe, to stay under per-second rate limits. */
  sleepAfter: boolean;
  build: (
    key: string,
    account: string
  ) => { url: string; headers: Record<string, string>; body: Json } | undefined;
}

const chat = (model: string): Json => ({
  model,
  messages: [{ role: "user", content: "OK" }],
  max_tokens: 2,
});
const bearer = (key: string): Record<string, string> => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
});
const plain: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
};

export const PROBES: ProbeDef[] = [
  {
    worker: "worker-google",
    keyFile: ".gemini-key",
    sleepAfter: true,
    build: (key) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      headers: plain,
      body: { contents: [{ parts: [{ text: "OK" }] }], generationConfig: { maxOutputTokens: 2 } },
    }),
  },
  {
    worker: "worker-zhipu",
    keyFile: ".zhipu-key",
    sleepAfter: true,
    build: (key) => ({
      url: "https://api.z.ai/api/paas/v4/chat/completions",
      headers: bearer(key),
      body: chat("glm-4.7-flash"),
    }),
  },
  {
    // The probe hits the worker's real endpoint (OpenRouter), not the old Mistral one.
    worker: "worker-codestral",
    keyFile: ".openrouter-key",
    sleepAfter: true,
    build: (key) => ({
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: bearer(key),
      body: chat("poolside/laguna-s-2.1:free"),
    }),
  },
  {
    worker: "worker-groq",
    keyFile: ".groq-key",
    sleepAfter: true,
    build: (key) => ({
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: bearer(key),
      body: chat("qwen/qwen3.8-27b"),
    }),
  },
  {
    worker: "worker-novita",
    keyFile: ".novita-key",
    sleepAfter: true,
    build: (key) => ({
      url: "https://api.novita.ai/openai/v1/chat/completions",
      headers: bearer(key),
      body: chat("inclusionai/ling-3.0-flash-sante"),
    }),
  },
  {
    worker: "worker-pollinations",
    timeoutMs: 45_000,
    sleepAfter: true,
    build: () => ({
      url: "https://text.pollinations.ai/openai",
      headers: plain,
      body: chat("openai"),
    }),
  },
  {
    worker: "worker-ollama",
    timeoutMs: 60_000,
    sleepAfter: false,
    build: () => ({
      url: "http://localhost:11434/v1/chat/completions",
      headers: plain,
      body: chat("devstral"),
    }),
  },
  {
    worker: "worker-cloudflare",
    keyFile: ".cloudflare-key",
    sleepAfter: false,
    build: (key, account) =>
      key && account
        ? {
            url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/zai-org/glm-4.7-flash`,
            headers: bearer(key),
            body: { messages: [{ role: "user", content: "OK" }] },
          }
        : undefined,
  },
];

// ── models.dev metadata (cache 24h, never blocking) ─────────────────────────
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_S = 86_400;
const MODELS_DEV_MAP: Record<string, Array<[string, string]>> = {
  "worker-groq": [["groq", "qwen/qwen3.8-27b"]],
  "worker-zhipu": [
    ["zhipuai", "glm-4.7-flash"],
    ["zai", "glm-4.7-flash"],
  ],
  "worker-codestral": [["openrouter", "poolside/laguna-s-2.1:free"]],
  "worker-novita": [["novita-ai", "inclusionai/ling-3.0-flash-sante"]],
  "worker-google": [["google", "gemini-2.5-flash"]],
};

export interface WorkerMeta {
  model: string;
  context: number;
  max_output: number;
  cost_in: number;
  cost_out: number;
}

export function extractMeta(api: unknown): Record<string, WorkerMeta> {
  const meta: Record<string, WorkerMeta> = {};
  if (!api || typeof api !== "object") return meta;
  for (const [worker, candidates] of Object.entries(MODELS_DEV_MAP)) {
    for (const [provider, id] of candidates) {
      const m = (api as any)?.[provider]?.models?.[id];
      if (!m || typeof m !== "object") continue;
      const limit = m.limit ?? {};
      const cost = m.cost ?? {};
      meta[worker] = {
        model: id,
        context: Number(limit.context) || 0,
        max_output: Number(limit.output) || 0,
        cost_in: Number(cost.input) || 0,
        cost_out: Number(cost.output) || 0,
      };
      break;
    }
  }
  return meta;
}

async function fetchModelsDev(
  dir: string,
  fetchImpl: FetchLike,
  log: (l: string) => void
): Promise<unknown> {
  const cachePath = join(dir, "models-dev-cache.json");
  const cache = readJson<{ fetched?: number; api?: unknown }>(cachePath);
  if (cache && Date.now() / 1000 - (cache.fetched ?? 0) < MODELS_DEV_TTL_S) return cache.api;
  try {
    const res = await fetchImpl(MODELS_DEV_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const api = await res.json();
    try {
      writeJson(cachePath, { fetched: Math.floor(Date.now() / 1000), api });
    } catch {
      // cache is best effort
    }
    return api;
  } catch (e) {
    log(
      `  [META] models.dev injoignable (${String((e as Error).message).slice(0, 60)}), sans metadonnees`
    );
    return undefined;
  }
}

export interface ProbeOptions {
  dir?: string;
  fetchImpl?: FetchLike;
  /** Pause between probes; tests pass 0. */
  delayMs?: number;
  log?: (line: string) => void;
}

export interface ProbeReport {
  updated: number;
  updated_human: string;
  models: Record<string, string>;
  latencies_ms: Record<string, number>;
  models_meta: Record<string, WorkerMeta>;
}

function localTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function runProbe(opts: ProbeOptions = {}): Promise<ProbeReport> {
  const dir = opts.dir ?? configDir();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayMs = opts.delayMs ?? 1500;
  const log = opts.log ?? ((l: string) => console.log(l));

  const models: Record<string, string> = {};
  const latencies: Record<string, number> = {};
  const account = readKey(dir, ".cloudflare-account");

  for (const def of PROBES) {
    const key = def.keyFile ? readKey(dir, def.keyFile) : "";
    const req = def.build(key, account);
    if (!req) {
      models[def.worker] = "skipped";
      latencies[def.worker] = 0;
    } else {
      const r: PostResult = await postJson(
        req.url,
        req.headers,
        req.body,
        def.timeoutMs ?? 30_000,
        fetchImpl
      );
      models[def.worker] = r.status;
      latencies[def.worker] = r.ms;
    }
    if (def.sleepAfter) await sleep(delayMs);
  }

  const meta = extractMeta(await fetchModelsDev(dir, fetchImpl, log));
  const missing = Object.keys(MODELS_DEV_MAP).filter((w) => !(w in meta));
  log(
    `  [META] ${Object.keys(meta).length}/${Object.keys(MODELS_DEV_MAP).length} modeles documentes` +
      (missing.length ? ` (absents: ${missing.join(", ")})` : "")
  );

  const now = new Date();
  const report: ProbeReport = {
    updated: Math.floor(now.getTime() / 1000),
    updated_human: localTimestamp(now),
    models,
    latencies_ms: latencies,
    models_meta: meta,
  };
  writeJson(join(dir, "free-models.json"), report);

  log("=== Tollfree Free Models Probe ===");
  log(`Updated: ${report.updated_human}`);
  log("");
  let ok = 0;
  let err = 0;
  for (const [name, status] of Object.entries(models)) {
    const lat = latencies[name] ?? 0;
    let marker = "[ERR]";
    if (status === "ok") {
      marker = "[OK]";
      ok++;
    } else if (status === "rate_limited") {
      marker = "[429]";
      err++;
    } else if (status === "skipped") {
      marker = "[SKIP]";
    } else {
      err++;
    }
    log(`  ${marker} ${pad(name, 20)} ${pad(status, 15)} ${String(lat).padStart(5)}ms`);
  }
  log("");
  log(`OK: ${ok} | Errors: ${err} | Total: ${Object.keys(models).length}`);
  return report;
}
