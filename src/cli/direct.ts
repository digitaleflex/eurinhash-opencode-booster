// src/cli/direct.ts — Direct provider calls with circuit breaker and local quota (ported from the former scripts/direct.py).
// Bypasses `opencode run` and talks to the provider APIs with the keys from the config dir.
// State files keep the Python format (provider_usage.json, provider_circuit.json).

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { configDir } from "../core/paths";
import { Color, FetchLike, paint, readJson, readKey, writeJson } from "./common";

export type Message = { role: "system" | "user" | "assistant"; content: string };

interface ProviderDef {
  keyFile: string;
  models: string[];
  endpoint: string;
  /** Daily local call budget per provider/model. */
  quota: number;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  groq: {
    keyFile: ".groq-key",
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"],
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    quota: 50,
  },
  mistral: {
    keyFile: ".mistral-key",
    models: ["codestral-latest", "mistral-code-latest"],
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    quota: 30,
  },
  google: {
    keyFile: ".gemini-key",
    models: [
      "gemini-2.5-flash",
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-flash-latest",
    ],
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    quota: 20,
  },
  zhipu: {
    keyFile: ".zhipu-key",
    models: ["glm-4.7-flash", "glm-5.3-flash"],
    endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
    quota: 20,
  },
  openrouter: {
    keyFile: ".openrouter-key",
    models: ["openrouter/free"],
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    quota: 30,
  },
  huggingface: {
    keyFile: ".hf-key",
    models: [
      "Qwen/Qwen3-Coder-480B-A35B-Instruct:cheapest",
      "deepseek-ai/DeepSeek-V4-Flash:cheapest",
    ],
    endpoint: "https://router.huggingface.co/v1/chat/completions",
    quota: 20,
  },
  novita: {
    keyFile: ".novita-key",
    models: [
      "deepseek-ai/DeepSeek-V4-Flash",
      "inclusionai/ling-3.0-flash-fin",
      "inclusionai/ling-3.0-flash-sante",
    ],
    endpoint: "https://api.novita.ai/v3/openai/chat/completions",
    quota: 30,
  },
  together: {
    keyFile: ".together-key",
    models: ["moonshotai/Kimi-K2.7-Code", "meta-llama/Llama-4-Maverick"],
    endpoint: "https://api.together.xyz/v1/chat/completions",
    quota: 20,
  },
  zenmux: {
    keyFile: ".zenmux-key",
    models: ["zenmux/free"],
    endpoint: "https://zenmux.ai/v1/chat/completions",
    quota: 20,
  },
};

const CIRCUIT_TIMEOUT_S = 60;
const FAILURE_THRESHOLD = 3;
const CODE_ORDER = ["groq", "mistral", "zhipu", "openrouter", "novita", "together"];
const CHAT_ORDER = ["groq", "zhipu", "mistral", "openrouter", "novita", "together"];

/** An HTTP or local failure; `status` drives the friendly message. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

interface CircuitEntry {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  last_failure: number;
}
type CircuitState = Record<string, CircuitEntry>;
type UsageState = Record<string, number>;

export interface DirectDeps {
  dir: string;
  fetchImpl: FetchLike;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function defaultDirectDeps(dir = configDir()): DirectDeps {
  return {
    dir,
    fetchImpl: fetch,
    now: () => Date.now(),
    out: (l) => console.log(l),
    err: (l) => process.stderr.write(l + "\n"),
  };
}

function today(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── state: circuit breaker + local quota ────────────────────────────────────

export class ProviderState {
  private readonly circuitFile: string;
  private readonly usageFile: string;

  constructor(
    readonly dir: string,
    private readonly now: () => number
  ) {
    this.circuitFile = join(dir, "provider_circuit.json");
    this.usageFile = join(dir, "provider_usage.json");
  }

  loadCircuit(): CircuitState {
    const saved = readJson<CircuitState>(this.circuitFile);
    if (saved) return saved;
    return Object.fromEntries(
      Object.keys(PROVIDERS).map((p) => [
        p,
        { state: "CLOSED", failures: 0, last_failure: 0 } as CircuitEntry,
      ])
    );
  }

  private saveCircuit(state: CircuitState): void {
    try {
      writeJson(this.circuitFile, state);
    } catch {
      // state is best effort
    }
  }

  /** CLOSED/HALF_OPEN let calls through; OPEN reopens to HALF_OPEN after the cool-down. */
  checkCircuit(provider: string): boolean {
    const all = this.loadCircuit();
    const s = all[provider] ?? { state: "CLOSED", failures: 0, last_failure: 0 };
    if (s.state === "OPEN") {
      if (this.now() / 1000 - s.last_failure > CIRCUIT_TIMEOUT_S) {
        all[provider] = { ...s, state: "HALF_OPEN" };
        this.saveCircuit(all);
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(provider: string): void {
    const all = this.loadCircuit();
    if (!all[provider]) return;
    all[provider].failures = 0;
    all[provider].state = "CLOSED";
    this.saveCircuit(all);
  }

  recordFailure(provider: string): void {
    const all = this.loadCircuit();
    if (!all[provider]) return;
    all[provider].failures = Number(all[provider].failures ?? 0) + 1;
    all[provider].last_failure = this.now() / 1000;
    if (all[provider].failures >= FAILURE_THRESHOLD) all[provider].state = "OPEN";
    this.saveCircuit(all);
  }

  loadUsage(): UsageState {
    return readJson<UsageState>(this.usageFile) ?? {};
  }

  private usageKey(provider: string, model: string): string {
    return `${provider}:${model}:${today(this.now())}`;
  }

  usageToday(provider: string, model: string): number {
    return Number(this.loadUsage()[this.usageKey(provider, model)] ?? 0);
  }

  checkQuota(provider: string, model: string): boolean {
    return this.usageToday(provider, model) < (PROVIDERS[provider]?.quota ?? 20);
  }

  recordUsage(provider: string, model: string): void {
    const usage = this.loadUsage();
    const key = this.usageKey(provider, model);
    usage[key] = Number(usage[key] ?? 0) + 1;
    try {
      writeJson(this.usageFile, usage);
    } catch {
      // state is best effort
    }
  }

  resetCircuit(): void {
    rmSync(this.circuitFile, { force: true });
  }
  resetUsage(): void {
    rmSync(this.usageFile, { force: true });
  }
}

// ── provider calls ──────────────────────────────────────────────────────────

export function loadKey(dir: string, provider: string): string | undefined {
  const def = PROVIDERS[provider];
  if (!def) return undefined;
  return readKey(dir, def.keyFile) || undefined;
}

export interface CallOptions {
  maxTokens: number;
  temperature: number;
}

type ChatResponse = Record<string, any>;

function buildRequest(
  provider: string,
  model: string,
  key: string,
  messages: Message[],
  o: CallOptions
): { url: string; headers: Record<string, string>; body: unknown } {
  const def = PROVIDERS[provider];
  if (provider === "google") {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    return {
      url: def.endpoint.replace("{model}", encodeURIComponent(model)),
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        generationConfig: { maxOutputTokens: o.maxTokens, temperature: o.temperature },
      },
    };
  }
  return {
    url: def.endpoint,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: { model, messages, max_tokens: o.maxTokens, temperature: o.temperature },
  };
}

/** One call to one provider, guarded by the circuit breaker and the local quota. */
export async function callProvider(
  provider: string,
  model: string,
  messages: Message[],
  o: CallOptions,
  deps: DirectDeps,
  state = new ProviderState(deps.dir, deps.now)
): Promise<ChatResponse> {
  if (!state.checkCircuit(provider)) {
    throw new ProviderError(
      `Circuit breaker OPEN pour ${provider} (retry dans ${CIRCUIT_TIMEOUT_S}s)`
    );
  }
  if (!state.checkQuota(provider, model)) {
    throw new ProviderError(`Quota local dépassé pour ${provider}/${model}`);
  }
  const key = loadKey(deps.dir, provider);
  if (!key) throw new ProviderError(`Cle ${provider} introuvable`);

  const req = buildRequest(provider, model, key, messages, o);
  try {
    const res = await deps.fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status} from ${provider}`, res.status);
    const json = (await res.json()) as ChatResponse;
    state.recordUsage(provider, model);
    state.recordSuccess(provider);
    return json;
  } catch (e) {
    state.recordFailure(provider);
    throw e;
  }
}

export function detectProvider(model: string): string | undefined {
  for (const [provider, def] of Object.entries(PROVIDERS)) {
    if (def.models.includes(model)) return provider;
  }
  if (model.includes("/")) {
    const prefix = model.split("/")[0].toLowerCase();
    if (prefix in PROVIDERS) return prefix;
  }
  return undefined;
}

export function extractContent(response: ChatResponse): string {
  try {
    const choice = response.choices?.[0];
    if (choice?.message) return choice.message.content ?? "";
    if (choice?.text) return choice.text;
    const part = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof part === "string") return part;
  } catch {
    // fall through to raw JSON
  }
  return JSON.stringify(response);
}

export function humanizeError(error: unknown): string {
  const msg = String((error as Error)?.message ?? error);
  const status =
    error instanceof ProviderError && error.status
      ? String(error.status)
      : /\b(\d{3})\b/.exec(msg)?.[1];
  const lower = msg.toLowerCase();
  if (status === "429") return "Rate limited (429) → Je bascule...";
  if (status === "401" || status === "403") return "Clé API refusée → Je bascule...";
  if (status === "404") return "Modèle introuvable → Je bascule...";
  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("timed out"))
    return "Délai dépassé → Je bascule...";
  if (lower.includes("circuit breaker") && msg.includes("OPEN"))
    return "En pause (circuit ouvert) → Je réessaie plus tard";
  if (lower.includes("quota") && lower.includes("local"))
    return "Quota du jour atteint → Je bascule...";
  if (msg.includes("Cle") && msg.includes("introuvable")) return "Clé non configurée → Ignoré";
  if (lower.includes("fetch failed") || lower.includes("network") || lower.includes("econn"))
    return "Réseau inaccessible → Je bascule...";
  return "Erreur inattendue → Je bascule...";
}

// ── progress output ─────────────────────────────────────────────────────────

class Progress {
  readonly fallbackPath: string[] = [];
  constructor(
    readonly enabled: boolean,
    private readonly color: boolean,
    private readonly verbose: boolean,
    private readonly out: (l: string) => void
  ) {}

  paint(color: Color, text: string): string {
    return paint(color, text, this.color);
  }

  line(text: string, color: Color = "dim"): void {
    if (this.enabled) this.out(this.paint(color, text));
  }

  chainResult(provider: string, ok: boolean, error?: unknown, elapsedMs = 0): void {
    if (!this.enabled) return;
    const timing = elapsedMs > 500 ? `    ${(elapsedMs / 1000).toFixed(1)}s` : "";
    if (ok) {
      this.out(this.paint("dim", `   └─ ${provider.padEnd(10)}✅ Prêt ! (${provider})${timing}`));
      return;
    }
    this.out(this.paint("dim", `   ├─ ${provider.padEnd(10)}❌ ${humanizeError(error)}${timing}`));
    if (this.verbose && error)
      this.out(this.paint("dim", `       ↳ ${(error as Error).message ?? error}`));
  }

  result(
    content: string,
    provider: string,
    model: string,
    elapsedMs: number,
    path: string[]
  ): void {
    if (!this.enabled) {
      this.out(`[${provider}/${model}] ${content}`);
      return;
    }
    const bar = "━".repeat(60);
    this.out("");
    this.out(this.paint("green", bar));
    this.out(
      this.paint("green", `🎯 RÉSULTAT  (${provider}/${model} · ${(elapsedMs / 1000).toFixed(1)}s)`)
    );
    this.out(this.paint("green", bar));
    this.out("");
    this.out(content);
    if (path.length > 1) {
      this.out("");
      this.out(this.paint("dim", `    ↳ Routé via fallback (${path.join(" → ")})`));
    }
    this.out(this.paint("green", bar));
    this.out("");
  }

  failure(error: unknown, err: (l: string) => void): void {
    const msg = (error as Error)?.message ?? String(error);
    if (!this.enabled) {
      err(`Erreur: ${msg}`);
      return;
    }
    const bar = "━".repeat(60);
    this.out("");
    this.out(this.paint("red", bar));
    this.out(this.paint("red", "⛔  Tous les providers ont échoué"));
    this.out(this.paint("red", bar));
    this.out("");
    this.out(this.paint("red", "   Impossible de générer une réponse."));
    this.out("");
    this.out(this.paint("dim", "    💡 Astuce : réessayez dans 1 minute, ou lancez"));
    this.out(this.paint("dim", "       `tollfree direct --status`"));
    this.out(this.paint("dim", "       pour voir l'état des providers."));
    this.out("");
    this.out(this.paint("dim", `    ↳ Dernière erreur technique : ${msg}`));
    this.out("");
  }
}

// ── fallback chain ──────────────────────────────────────────────────────────

export interface ChainResult {
  response?: ChatResponse;
  provider?: string;
  model?: string;
  error?: string;
}

export async function autoFallbackChat(
  messages: Message[],
  taskType: string,
  o: CallOptions,
  deps: DirectDeps,
  progress: Progress
): Promise<ChainResult> {
  const state = new ProviderState(deps.dir, deps.now);
  const order = (taskType === "code" ? CODE_ORDER : CHAT_ORDER).filter((p) => loadKey(deps.dir, p));
  let lastError: unknown;
  for (const provider of order) {
    if (!state.checkCircuit(provider)) {
      if (progress.enabled)
        progress.chainResult(provider, false, new ProviderError("Circuit breaker OPEN"));
      else deps.err(`[circuit] ${provider} bloque (Circuit OPEN)`);
      continue;
    }
    const model = PROVIDERS[provider].models[0];
    const t0 = deps.now();
    try {
      const response = await callProvider(provider, model, messages, o, deps, state);
      progress.fallbackPath.push(provider);
      progress.chainResult(provider, true, undefined, deps.now() - t0);
      return { response, provider, model };
    } catch (e) {
      lastError = e;
      progress.fallbackPath.push(provider);
      if (progress.enabled) progress.chainResult(provider, false, e, deps.now() - t0);
      else deps.err(`[fallback] ${provider} failed: ${(e as Error).message}`);
    }
  }
  const reason = lastError ? (lastError as Error).message : "no provider with a key";
  return { error: `All providers failed: ${reason}` };
}

// ── command ─────────────────────────────────────────────────────────────────

const OPTIONS = {
  model: { type: "string", short: "m" },
  provider: { type: "string", short: "p" },
  "task-type": { type: "string", default: "auto" },
  "max-tokens": { type: "string", default: "2048" },
  temperature: { type: "string", default: "0.2" },
  list: { type: "boolean" },
  "list-providers": { type: "boolean" },
  json: { type: "boolean" },
  "reset-quota": { type: "boolean" },
  "reset-circuit": { type: "boolean" },
  status: { type: "boolean" },
  batch: { type: "string" },
  output: { type: "string" },
  progress: { type: "boolean", short: "P" },
  verbose: { type: "boolean", short: "V" },
  "no-color": { type: "boolean" },
  "force-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export const DIRECT_HELP = `Usage: tollfree direct [prompt] [options]

  -m, --model <id>        Specific model (provider is detected)
  -p, --provider <name>   Specific provider (default model = its first one)
      --task-type <t>     code | chat | auto (fallback order)
      --max-tokens <n>    default 2048
      --temperature <x>   default 0.2
      --batch <file>      One prompt per line; --output <file> writes JSON
      --json              Raw JSON output
  -P, --progress          Friendly progress output;  -V, --verbose adds raw errors
      --no-color / --force-color
      --status            Local quota and circuit breaker state
      --list / --list-providers
      --reset-quota / --reset-circuit
`;

export async function runDirect(
  argv: string[],
  deps: DirectDeps = defaultDirectDeps()
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    deps.err(`${(e as Error).message}\n\n${DIRECT_HELP}`);
    return 1;
  }
  const a = parsed.values;
  const state = new ProviderState(deps.dir, deps.now);

  if (a.help) {
    deps.out(DIRECT_HELP);
    return 0;
  }
  if (a["reset-quota"]) {
    state.resetUsage();
    deps.out("Compteurs de quota reinitialises");
    return 0;
  }
  if (a["reset-circuit"]) {
    state.resetCircuit();
    deps.out("Circuit breakers reinitialises");
    return 0;
  }
  if (a.status) {
    deps.out("=== Quota tracking ===");
    for (const [provider, def] of Object.entries(PROVIDERS)) {
      const model = def.models[0];
      deps.out(`  ${provider}/${model}: ${state.usageToday(provider, model)}/${def.quota}`);
    }
    deps.out("");
    deps.out("=== Circuit breakers ===");
    for (const [provider, s] of Object.entries(state.loadCircuit())) {
      deps.out(`  ${provider}: ${s.state} (failures=${s.failures ?? 0})`);
    }
    return 0;
  }
  if (a.list) {
    deps.out("Modeles disponibles par provider :");
    for (const [provider, def] of Object.entries(PROVIDERS)) {
      deps.out(`  ${provider} ${loadKey(deps.dir, provider) ? "[OK]" : "[NO]"}:`);
      for (const m of def.models) deps.out(`    - ${m}`);
    }
    return 0;
  }
  if (a["list-providers"]) {
    deps.out("Providers configures :");
    for (const [provider, def] of Object.entries(PROVIDERS)) {
      const status = loadKey(deps.dir, provider) ? "[OK] OK" : "[NO] NO KEY";
      deps.out(`  ${provider}: ${status} (${join(deps.dir, def.keyFile)})`);
    }
    return 0;
  }

  const useColor = a["force-color"]
    ? true
    : a["no-color"] || process.env.NO_COLOR !== undefined || !process.stdout.isTTY
      ? false
      : true;
  const progress = new Progress(Boolean(a.progress), useColor, Boolean(a.verbose), deps.out);
  const opts: CallOptions = {
    maxTokens: parseInt(a["max-tokens"] as string, 10) || 2048,
    temperature: Number.isNaN(parseFloat(a.temperature as string))
      ? 0.2
      : parseFloat(a.temperature as string),
  };
  const taskType = a["task-type"] as string;

  // Resolves the provider/model to use (explicit provider, explicit model, or auto fallback).
  const callOne = async (prompt: string): Promise<ChainResult> => {
    const messages: Message[] = [{ role: "user", content: prompt }];
    if (a.provider) {
      if (!(a.provider in PROVIDERS)) throw new ProviderError(`Provider inconnu: ${a.provider}`);
      const model = a.model ?? PROVIDERS[a.provider].models[0];
      const response = await callProvider(a.provider, model, messages, opts, deps, state);
      return { response, provider: a.provider, model };
    }
    if (a.model) {
      const provider = detectProvider(a.model);
      if (!provider) throw new ProviderError(`Impossible de detecter le provider pour: ${a.model}`);
      const response = await callProvider(provider, a.model, messages, opts, deps, state);
      return { response, provider, model: a.model };
    }
    return autoFallbackChat(messages, taskType, opts, deps, progress);
  };

  if (a.batch) {
    if (!existsSync(a.batch)) {
      deps.err(`Erreur: fichier batch ${a.batch} introuvable`);
      return 1;
    }
    const prompts = readFileSync(a.batch, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (prompts.length === 0) {
      deps.err("Erreur: fichier batch vide");
      return 1;
    }
    const results: Array<Record<string, unknown>> = [];
    let failed = 0;
    for (const [i, prompt] of prompts.entries()) {
      const filled = Math.floor(((i + 1) / prompts.length) * 20);
      progress.line(
        `\n📦 Traitement batch (${i + 1}/${prompts.length}) ${"█".repeat(filled)}${"░".repeat(20 - filled)} ${Math.round(((i + 1) / prompts.length) * 100)}%`,
        "cyan"
      );
      try {
        const r = await callOne(prompt);
        if (r.error || !r.response) throw new ProviderError(r.error ?? "empty response");
        results.push({ ...r.response, _provider_used: r.provider, _model_used: r.model });
      } catch (e) {
        failed++;
        progress.line(`   ❌ ${humanizeError(e)}`, "red");
        results.push({ error: (e as Error).message, _error_prompt: prompt });
      }
    }
    if (a.json || a.output) {
      const text = JSON.stringify(
        {
          batch_file: a.batch,
          timestamp: Math.floor(deps.now() / 1000),
          prompts_count: prompts.length,
          results,
        },
        null,
        2
      );
      if (a.output) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(a.output, text, "utf8");
        progress.line(`Résultats batch sauvegardés dans: ${a.output}`, "green");
      } else deps.out(text);
    } else {
      results.forEach((r, i) => {
        if ("error" in r) deps.out(`   [${i + 1}] ❌ ERREUR: ${r._error_prompt}`);
        else deps.out(`   [${i + 1}] [${r._provider_used}/${r._model_used}] ${extractContent(r)}`);
      });
    }
    progress.line(`\n✅ Batch terminé · ${prompts.length} prompts · ${failed} échec(s)`, "green");
    return failed > 0 && failed === prompts.length ? 1 : 0;
  }

  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt) {
    deps.out(DIRECT_HELP);
    return 0;
  }

  progress.line("🚀 Initialisation du système", "dim");
  progress.line(
    `   ✓ Clés chargées (${Object.keys(PROVIDERS).filter((p) => loadKey(deps.dir, p)).length} providers)`
  );
  const t0 = deps.now();
  let r: ChainResult;
  try {
    r = await callOne(prompt);
  } catch (e) {
    if (a.json) deps.err(JSON.stringify({ error: (e as Error).message }));
    else progress.failure(e, deps.err);
    return 1;
  }
  if (r.error || !r.response) {
    if (a.json) deps.err(JSON.stringify({ error: r.error }));
    else progress.failure(new Error(r.error ?? "Unknown error"), deps.err);
    return 1;
  }
  if (a.json) {
    deps.out(
      JSON.stringify({ ...r.response, _provider_used: r.provider, _model_used: r.model }, null, 2)
    );
    return 0;
  }
  const path = progress.fallbackPath.length ? progress.fallbackPath : [r.provider as string];
  progress.result(
    extractContent(r.response),
    r.provider as string,
    r.model as string,
    deps.now() - t0,
    path
  );
  return 0;
}
