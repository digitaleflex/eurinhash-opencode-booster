// src/core/paths.ts — Where Tollfree and OpenCode keep their files, on any OS.
// Resolution order for the config dir: TOLLFREE_DIR > OPENCODE_CONFIG_DIR >
// $XDG_CONFIG_HOME/opencode > ~/.config/opencode (OpenCode's own default on
// Linux, macOS and Windows). Never hard-code "~/.config/opencode" elsewhere.

import { homedir } from "node:os";
import { join } from "node:path";

function fromEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function configDir(): string {
  const explicit = fromEnv("TOLLFREE_DIR") ?? fromEnv("OPENCODE_CONFIG_DIR");
  if (explicit) return explicit;
  const xdg = fromEnv("XDG_CONFIG_HOME");
  return join(xdg ?? join(homedir(), ".config"), "opencode");
}

/** OpenCode's data dir (holds opencode.db). */
export function dataDir(): string {
  const xdg = fromEnv("XDG_DATA_HOME");
  return join(xdg ?? join(homedir(), ".local", "share"), "opencode");
}

export function logsDir(): string {
  return join(configDir(), "logs");
}
