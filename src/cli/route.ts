// src/cli/route.ts — Expected-value routing (ported from the former scripts/route.py).
//
//   EV(worker) = quality x availability / cost
//   quality      : 0-1 per model family (baseline, adjusted by a Bayesian feedback loop)
//   availability : 1.0 ok, 0.2 rate_limited, 0 error (live probe)
//   cost         : normalized latency (ms/1000 + 1)
//
// Output stays parseable: "worker|model|note|EV=x.xxx|..."

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../core/paths";
import { pad, readJson, writeJson } from "./common";
import { runProbe } from "./probe";

export type TaskType = "code" | "general" | "quick" | "long" | "heavy" | "review";

export interface WorkerDef {
  model: string;
  kind: "integrated" | "external";
  ctx: number;
  types: TaskType[];
  probe?: string;
  note: string;
}

export const QUALITY: Record<string, number> = {
  "worker-opencode": 0.9,
  "worker-opencode-heavy": 0.93,
  "worker-codestral": 0.88,
  "worker-groq": 0.82,
  "worker-novita": 0.85,
  "worker-zhipu": 0.85,
  "worker-google": 0.96,
  "worker-pollinations": 0.7,
  "worker-nvidia": 0.88,
  "worker-pro-openrouter": 0.92,
  "worker-pro-opencode-go": 0.94,
};

const ALL: TaskType[] = ["code", "general", "quick", "long", "review", "heavy"];

export const WORKERS: Record<string, WorkerDef> = {
  "worker-opencode": {
    model: "opencode/deepseek-v4-flash",
    kind: "integrated",
    ctx: 200_000,
    types: ["code", "general", "quick", "long", "review"],
    note: "intégré 0 quota, workhorse",
  },
  "worker-opencode-heavy": {
    model: "opencode/glm-5",
    kind: "integrated",
    ctx: 204_800,
    types: ["heavy", "review", "general"],
    note: "intégré 0 quota, raisonnement lourd",
  },
  "worker-codestral": {
    model: "openrouter/poolside/laguna-s-2.1:free",
    kind: "external",
    ctx: 262_144,
    types: ["code", "long"],
    probe: "worker-codestral",
    note: "code spécialisé, 262k ctx (:free)",
  },
  "worker-groq": {
    model: "groq/qwen/qwen3.8-27b",
    kind: "external",
    ctx: 131_042,
    types: ["quick", "general"],
    probe: "worker-groq",
    note: "le plus rapide (ITPM 7000, 131k ctx)",
  },
  "worker-novita": {
    model: "novita/inclusionai/ling-3.0-flash-sante",
    kind: "external",
    ctx: 256_000,
    types: ["long", "general"],
    probe: "worker-novita",
    note: "256K ctx, gratuit",
  },
  "worker-zhipu": {
    model: "zhipu/glm-4.7-flash",
    kind: "external",
    ctx: 200_000,
    types: ["general", "review"],
    probe: "worker-zhipu",
    note: "générique, latence parfois élevée",
  },
  "worker-google": {
    model: "google/gemini-2.5-flash",
    kind: "external",
    ctx: 1_048_576,
    types: ["general", "long"],
    probe: "worker-google",
    note: "polyvalent, 20 req/jour",
  },
  "worker-pollinations": {
    model: "pollinations/openai",
    kind: "external",
    ctx: 128_000,
    types: ["quick", "general"],
    probe: "worker-pollinations",
    note: "sans clé, 1 req/15s, réponses concises",
  },
  "worker-nvidia": {
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    kind: "external",
    ctx: 262_144,
    types: ["code", "general", "quick", "long", "review"],
    probe: "worker-nvidia",
    note: "NVIDIA Nemotron GRATUIT, 1000 req/jour",
  },
  "worker-pro-openrouter": {
    model: "openrouter/openai/gpt-4o-mini",
    kind: "external",
    ctx: 128_000,
    types: ALL,
    probe: "worker-pro-openrouter",
    note: "OpenRouter PAYG, modèles économiques",
  },
  "worker-pro-opencode-go": {
    model: "opencode-go/deepseek-v4.1-flash",
    kind: "external",
    ctx: 200_000,
    types: ALL,
    probe: "worker-pro-opencode-go",
    note: "opencode-go abonnement, $0/token",
  },
};

export const TYPE_ORDER: Record<TaskType, string[]> = {
  code: ["worker-opencode", "worker-codestral", "worker-groq", "worker-novita", "worker-nvidia"],
  general: [
    "worker-opencode",
    "worker-groq",
    "worker-novita",
    "worker-pollinations",
    "worker-zhipu",
    "worker-google",
    "worker-nvidia",
  ],
  quick: ["worker-groq", "worker-opencode", "worker-pollinations", "worker-nvidia"],
  long: ["worker-novita", "worker-opencode", "worker-codestral", "worker-google", "worker-nvidia"],
  heavy: ["worker-opencode-heavy", "worker-codestral", "worker-zhipu", "worker-nvidia"],
  review: [
    "worker-opencode-heavy",
    "worker-opencode",
    "worker-zhipu",
    "worker-codestral",
    "worker-nvidia",
  ],
};

export const TYPE_ORDER_PRO: Record<TaskType, string[]> = {
  code: ["worker-pro-opencode-go", "worker-pro-openrouter", "worker-opencode", "worker-nvidia"],
  general: [
    "worker-pro-opencode-go",
    "worker-pro-openrouter",
    "worker-opencode",
    "worker-novita",
    "worker-nvidia",
  ],
  quick: [
    "worker-pro-opencode-go",
    "worker-pro-openrouter",
    "worker-groq",
    "worker-opencode",
    "worker-nvidia",
  ],
  long: [
    "worker-pro-openrouter",
    "worker-pro-opencode-go",
    "worker-novita",
    "worker-opencode",
    "worker-nvidia",
  ],
  heavy: [
    "worker-pro-opencode-go",
    "worker-pro-openrouter",
    "worker-opencode-heavy",
    "worker-nvidia",
  ],
  review: [
    "worker-pro-opencode-go",
    "worker-pro-openrouter",
    "worker-opencode-heavy",
    "worker-opencode",
    "worker-nvidia",
  ],
};

export const AVAIL: Record<string, number> = {
  ok: 1.0,
  rate_limited: 0.2,
  error: 0.0,
  skipped: 0.0,
  unknown: 0.5,
};

/** Minimum context (tokens) a worker needs for these task types, else its availability is cut to 25%. */
const CTX_THRESHOLD: Partial<Record<TaskType, number>> = { long: 200_000, heavy: 200_000 };

export interface UsageStats {
  ok: number;
  fail: number;
}
export type Usage = Record<string, UsageStats>;

export interface ModelMeta {
  context?: number;
}
export interface Status {
  models?: Record<string, string>;
  latencies_ms?: Record<string, number>;
  models_meta?: Record<string, ModelMeta>;
}

export interface Candidate {
  name: string;
  ev: number;
  quality: number;
  avail: number;
  latency: number;
  status: string;
  worker: WorkerDef;
}

/** Baseline quality adjusted by feedback; the baseline counts as 4 prior observations. */
export function effectiveQuality(worker: string, usage: Usage): number {
  const base = QUALITY[worker] ?? 0.8;
  const stats = usage[worker] ?? { ok: 0, fail: 0 };
  const n = stats.ok + stats.fail;
  if (n === 0) return base;
  return (4 * base + n * (stats.ok / n)) / (4 + n);
}

export function computeEv(
  taskType: TaskType,
  status: Status,
  usage: Usage,
  pro = false
): Candidate[] {
  const lat = status.latencies_ms ?? {};
  const models = status.models ?? {};
  const meta = status.models_meta ?? {};
  const order = (pro ? TYPE_ORDER_PRO : TYPE_ORDER)[taskType] ?? [];

  const results: Candidate[] = [];
  for (const name of order) {
    const w = WORKERS[name];
    const quality = effectiveQuality(name, usage);
    let avail: number;
    let latency: number;
    let st: string;
    if (w.kind === "integrated") {
      avail = 1.0;
      latency = 0;
      st = "integrated";
    } else {
      st = models[w.probe as string] ?? "unknown";
      avail = AVAIL[st] ?? 0.5;
      latency = lat[w.probe as string] ?? 5000;
    }
    const ctx = meta[name]?.context || w.ctx || 0;
    const min = CTX_THRESHOLD[taskType];
    if (min && ctx && ctx < min) avail *= 0.25;
    const cost = latency / 1000 + 1.0;
    results.push({
      name,
      ev: (quality * avail) / cost,
      quality,
      avail,
      latency,
      status: st,
      worker: w,
    });
  }
  return results.sort((a, b) => b.ev - a.ev);
}

export interface RouteDeps {
  dir: string;
  loadStatus: () => Promise<Status>;
  refresh: () => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE_TEXT =
  "Usage: tollfree route <type> [--next[=N]] [--pro] | list | report | record <worker> <success|fail> | --refresh\n" +
  `Types: ${Object.keys(TYPE_ORDER).join(", ")}\n`;

export function defaultDeps(dir = configDir()): RouteDeps {
  const file = join(dir, "free-models.json");
  return {
    dir,
    refresh: async () => {
      await runProbe({ dir, log: () => undefined });
    },
    loadStatus: async () => {
      const stale = !existsSync(file) || Date.now() / 1000 - statSync(file).mtimeMs / 1000 >= 1800;
      if (stale) await runProbe({ dir, log: () => undefined });
      return readJson<Status>(file) ?? {};
    },
    out: (l) => console.log(l),
    err: (l) => process.stderr.write(l + "\n"),
  };
}

/** Returns the process exit code. */
export async function runRoute(argv: string[], deps: RouteDeps = defaultDeps()): Promise<number> {
  const usagePath = join(deps.dir, "route-usage.json");
  const loadUsage = (): Usage => readJson<Usage>(usagePath) ?? {};
  let args = [...argv];

  if (args.length === 0) {
    deps.err(USAGE_TEXT.trimEnd());
    return 1;
  }

  if (args[0] === "record" && args.length >= 3) {
    const [, worker, outcome] = args;
    if (!(worker in WORKERS) || (outcome !== "success" && outcome !== "fail")) {
      deps.err("Usage: tollfree route record <worker> <success|fail>");
      return 1;
    }
    const usage = loadUsage();
    const stats = (usage[worker] ??= { ok: 0, fail: 0 });
    stats[outcome === "success" ? "ok" : "fail"] += 1;
    writeJson(usagePath, usage);
    deps.out(`recorded ${worker} ${outcome} (ok=${stats.ok}, fail=${stats.fail})`);
    return 0;
  }

  if (args[0] === "list") {
    const status = await deps.loadStatus();
    const lat = status.latencies_ms ?? {};
    const models = status.models ?? {};
    const meta = status.models_meta ?? {};
    const usage = loadUsage();
    deps.out(
      `${pad("worker", 24)} ${pad("statut", 12)} ${pad("latence", 8)} ${pad("qualité", 8)} ${pad("EV(code)", 8)} ${pad("ctx", 8)} modèle`
    );
    for (const [name, w] of Object.entries(WORKERS)) {
      const q = effectiveQuality(name, usage);
      let st: string;
      let l: number | string;
      if (w.kind === "integrated") {
        st = "integrated";
        l = 0;
      } else {
        st = models[w.probe as string] ?? "unknown";
        l = lat[w.probe as string] ?? "?";
      }
      const avail = w.kind === "external" ? (AVAIL[st] ?? 0.5) : 1.0;
      const ev = (q * avail) / (typeof l === "number" ? l / 1000 + 1 : 6);
      const ctx = meta[name]?.context;
      const ctxS = ctx ? `${Math.floor(ctx / 1000)}k` : "-";
      deps.out(
        `${pad(name, 24)} ${pad(st, 12)} ${pad(l, 8)} ${pad(q.toFixed(2), 8)} ${pad(ev.toFixed(3), 8)} ${pad(ctxS, 8)} ${w.model}`
      );
    }
    return 0;
  }

  if (args[0] === "report") {
    const status = await deps.loadStatus();
    const usage = loadUsage();
    for (const t of Object.keys(TYPE_ORDER) as TaskType[]) {
      const best = computeEv(t, status, usage)[0];
      deps.out(
        `${pad(t, 8)} -> ${best.name} (EV=${best.ev.toFixed(3)}, q=${best.quality.toFixed(2)}, lat=${Math.round(best.latency)}ms)`
      );
    }
    return 0;
  }

  if (args[0] === "--refresh") {
    await deps.refresh();
    return 0;
  }

  const pro = args.includes("--pro");
  if (pro) args = args.filter((a) => a !== "--pro");

  const taskType = args[0] as TaskType;
  if (!(taskType in TYPE_ORDER)) {
    deps.err(`Type inconnu '${taskType}'. Types: ${Object.keys(TYPE_ORDER).join(", ")}`);
    return 1;
  }

  let skip = 0;
  if (args.some((a) => a.startsWith("--next"))) {
    skip = 1;
    for (const a of args) {
      if (a.startsWith("--next=")) skip = parseInt(a.split("=")[1], 10) || 0;
    }
  }

  const status = await deps.loadStatus();
  const usage = loadUsage();
  let results = computeEv(taskType, status, usage, pro);
  if (skip >= results.length) {
    if (pro) {
      deps.err("AUCUN_WORKER_PRO_DISPO — fallback vers FREE.");
      results = computeEv(taskType, status, usage, false);
    }
    if (skip >= results.length) {
      deps.err("AUCUN_WORKER_DISPO — tous KO. Fallback payant (validation utilisateur requise).");
      return 2;
    }
  }

  const r = results[skip];
  deps.out(
    `${r.name}|${r.worker.model}|${r.worker.note}|EV=${r.ev.toFixed(3)}|qualité=${r.quality.toFixed(2)}|latence=${Math.round(r.latency)}ms|statut=${r.status}|mode=${pro ? "PRO" : "FREE"}`
  );
  return 0;
}
