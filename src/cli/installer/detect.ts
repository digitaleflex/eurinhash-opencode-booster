// src/cli/installer/detect.ts — What does this machine have? (OS, OpenCode, API keys, Ollama)
// Nothing here reveals a secret: keys are reported by source only.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { FetchLike, keySource } from "../common";

/** Provider id (as used in `model: provider/...`) -> key file / env var it needs. */
export const PROVIDER_KEY: Record<string, string> = {
  groq: ".groq-key",
  google: ".gemini-key",
  zhipu: ".zhipu-key",
  openrouter: ".openrouter-key",
  novita: ".novita-key",
  zenmux: ".zenmux-key",
  mistral: ".mistral-key",
  huggingface: ".hf-key",
  together: ".together-key",
};

/** Providers that work with no key of ours. */
export const KEYLESS_PROVIDERS = ["opencode", "pollinations"];

export interface Detected {
  platform: NodeJS.Platform;
  node: string;
  opencode: { found: boolean; version?: string };
  ollama: boolean;
  /** Agents run `tollfree ...` in a shell, so the command must be on PATH (npm i -g tollfree). */
  tollfreeOnPath: boolean;
  /** provider id -> where its key was found; absent when missing. */
  keys: Record<string, { source: "file" | "env"; detail: string }>;
}

export interface DetectOptions {
  dir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Injected in tests; defaults to spawning `opencode --version`. */
  opencodeVersion?: () => string | undefined;
  checkOllama?: boolean;
}

export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat("") : [""];
  return (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((d) =>
      exts.some((e) => existsSync(join(d, cmd + e.toLowerCase())) || existsSync(join(d, cmd + e)))
    );
}

function opencodeVersion(): string | undefined {
  try {
    const r = spawnSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      shell: process.platform === "win32",
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  } catch {
    // not installed
  }
  return undefined;
}

export async function detectEnvironment(o: DetectOptions): Promise<Detected> {
  const env = o.env ?? process.env;
  const keys: Detected["keys"] = {};
  for (const [provider, file] of Object.entries(PROVIDER_KEY)) {
    const found = keySource(o.dir, file, env);
    if (found) keys[provider] = found;
  }

  let ollama = false;
  if (o.checkOllama !== false) {
    try {
      const res = await (o.fetchImpl ?? fetch)("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(1500),
      });
      ollama = res.ok;
    } catch {
      ollama = false;
    }
  }

  const version = (o.opencodeVersion ?? opencodeVersion)();
  return {
    platform: process.platform,
    node: process.versions.node,
    opencode: { found: version !== undefined, version },
    ollama,
    tollfreeOnPath: onPath("tollfree", env),
    keys,
  };
}

/** Can a `model: provider/...` line work on this machine? */
export function providerAvailable(provider: string, d: Detected): boolean {
  if (KEYLESS_PROVIDERS.includes(provider)) return true;
  if (provider === "ollama") return d.ollama;
  return provider in d.keys;
}
