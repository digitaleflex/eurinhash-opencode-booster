// src/cli/common.ts — Helpers shared by the Tollfree CLI commands (Node >= 18, no Bun-only APIs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenCode";

const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

export type Color = keyof Omit<typeof ANSI, "reset">;

export function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function paint(color: Color, text: string, enabled = useColor()): string {
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

export const green = (t: string) => paint("green", t);
export const yellow = (t: string) => paint("yellow", t);
export const red = (t: string) => paint("red", t);
export const bold = (t: string) => paint("bold", t);
export const dim = (t: string) => paint("dim", t);

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

/** Environment variables that can stand in for a key file (first one set wins). */
export const KEY_ENV: Record<string, string[]> = {
  ".groq-key": ["GROQ_API_KEY"],
  ".gemini-key": ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  ".zhipu-key": ["ZHIPU_API_KEY", "ZAI_API_KEY"],
  ".openrouter-key": ["OPENROUTER_API_KEY"],
  ".novita-key": ["NOVITA_API_KEY"],
  ".mistral-key": ["MISTRAL_API_KEY"],
  ".hf-key": ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
  ".together-key": ["TOGETHER_API_KEY"],
  ".zenmux-key": ["ZENMUX_API_KEY"],
  ".cloudflare-key": ["CLOUDFLARE_API_TOKEN"],
  ".cloudflare-account": ["CLOUDFLARE_ACCOUNT_ID"],
};

/** Where a key comes from, without revealing it. */
export function keySource(
  dir: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env
): { source: "file" | "env"; detail: string } | undefined {
  try {
    if (readFileSync(join(dir, name), "utf8").trim())
      return { source: "file", detail: join(dir, name) };
  } catch {
    // fall through to the environment
  }
  for (const v of KEY_ENV[name] ?? []) {
    if (env[v]?.trim()) return { source: "env", detail: v };
  }
  return undefined;
}

/** Reads a secret: the one-line key file (e.g. `.groq-key`) in the config dir, else its environment variable; "" when missing. */
export function readKey(dir: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const fromFile = readFileSync(join(dir, name), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    // fall through to the environment
  }
  for (const v of KEY_ENV[name] ?? []) {
    const value = env[v]?.trim();
    if (value) return value;
  }
  return "";
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PostResult {
  status: "ok" | "rate_limited" | "error";
  code: number | string;
  ms: number;
}

/** One JSON POST; never throws. 2xx -> ok, 429 -> rate_limited, anything else -> error. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 30_000,
  fetchImpl: FetchLike = fetch
): Promise<PostResult> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - t0;
    if (res.ok) return { status: "ok", code: res.status, ms };
    if (res.status === 429) return { status: "rate_limited", code: 429, ms };
    return { status: "error", code: res.status, ms };
  } catch (e) {
    return {
      status: "error",
      code: String((e as Error)?.message ?? e).slice(0, 80),
      ms: Date.now() - t0,
    };
  }
}

export function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}
