// src/cli/models-free.ts — Lists truly free models (input cost 0) from models.dev (ported from the former scripts/models-free.py).

import { FetchLike, USER_AGENT } from "./common";

const API_URL = "https://models.dev/api.json";
const PRIORITY = [
  "openrouter",
  "google",
  "groq",
  "huggingface",
  "novita",
  "zhipu",
  "pollinations",
  "ollama",
];
const CODE_HINTS = [
  "coder",
  "code",
  "laguna",
  "devstral",
  "qwen",
  "deepseek",
  "glm",
  "gpt-oss",
  "kimi",
  "llama",
];

export interface FreeEntry {
  id: string;
  context: number | string;
}

/** Free models of one provider; `codeOnly` keeps code-oriented ones (by id or display name). */
export function freeModelsOf(provider: any, codeOnly: boolean): FreeEntry[] {
  const found: FreeEntry[] = [];
  for (const [id, m] of Object.entries<any>(provider?.models ?? {})) {
    if ((m?.cost?.input ?? 1) !== 0) continue;
    if (codeOnly) {
      const hay = `${id} ${m?.name ?? ""}`.toLowerCase();
      if (!CODE_HINTS.some((h) => hay.includes(h))) continue;
    }
    found.push({ id, context: m?.limit?.context ?? "?" });
  }
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function runModelsFree(
  argv: string[],
  fetchImpl: FetchLike = fetch,
  out: (l: string) => void = console.log
): Promise<number> {
  const codeOnly = argv.includes("--code");
  const only = argv.find((a) => !a.startsWith("-"));
  let data: any;
  try {
    const res = await fetchImpl(API_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    process.stderr.write(`models.dev injoignable: ${(e as Error).message}\n`);
    return 1;
  }
  const providers = data?.providers ?? data;
  let total = 0;
  for (const name of only ? [only] : PRIORITY) {
    if (!providers?.[name]) {
      out(`\n[${name}] ABSENT de models.dev`);
      continue;
    }
    const free = freeModelsOf(providers[name], codeOnly);
    if (free.length === 0) {
      out(`\n[${name}] aucun modèle gratuit détecté`);
      continue;
    }
    out(`\n[${name}] ${free.length} modèle(s) gratuit(s) :`);
    for (const m of free) {
      out(`  ${m.id}  (ctx ${m.context})`);
      total++;
    }
  }
  out(`\nTotal : ${total} modèle(s) gratuit(s)`);
  return 0;
}
