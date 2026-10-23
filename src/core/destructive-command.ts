// src/core/destructive-command.ts — Runtime destructive-command detector used by plugin/guard.ts.
// Narrow on purpose: it only blocks commands that are catastrophic whatever the
// context (wiping /, ~, a disk, or rewriting remote history). Normal work such as
// `rm -rf node_modules` must keep running. The command is canonicalized first
// (GuardFall defense: $IFS, quotes, escapes) so trivial obfuscations do not slip through.

import { GuardOverrides } from "./guard-overrides";

export interface DestructiveVerdict {
  blocked: boolean;
  reason?: string;
}

const canonicalizer = new GuardOverrides();

// Targets that wipe the system or the home directory.
const CATASTROPHIC_RM_TARGETS = new Set(["/", "/*", "/.", "//", "~", "~/", "~/*", "~/."]);

// Wrappers that do not change what the wrapped command does.
const PASSTHROUGH_PREFIXES = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "env",
]);

function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (PASSTHROUGH_PREFIXES.has(t)) {
      i++;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++; // VAR=value prefix
    } else if (i > 0 && t.startsWith("-") && PASSTHROUGH_PREFIXES.has(tokens[i - 1])) {
      i++; // e.g. `sudo -u root`
    } else {
      break;
    }
  }
  return tokens.slice(i);
}

function checkRm(args: string[]): string | undefined {
  let recursive = false;
  let noPreserveRoot = false;
  let endOfFlags = false;
  const targets: string[] = [];
  for (const a of args) {
    if (!endOfFlags && a === "--") {
      endOfFlags = true;
    } else if (!endOfFlags && a.startsWith("--")) {
      if (a === "--recursive") recursive = true;
      if (a === "--no-preserve-root") noPreserveRoot = true;
    } else if (!endOfFlags && a.startsWith("-") && a.length > 1) {
      if (/[rR]/.test(a)) recursive = true;
    } else {
      targets.push(a);
    }
  }
  if (noPreserveRoot) return "rm --no-preserve-root";
  if (recursive && targets.some((t) => CATASTROPHIC_RM_TARGETS.has(t))) {
    return "suppression récursive de / ou du dossier personnel";
  }
  return undefined;
}

function checkGitPush(args: string[]): string | undefined {
  if (args[0] !== "push") return undefined;
  for (const a of args.slice(1)) {
    if (a.startsWith("--force")) return "git push --force";
    if (/^-[A-Za-z]*f[A-Za-z]*$/.test(a)) return "git push -f";
    if (/^\+[^\s]/.test(a)) return "git push +refspec (force)";
  }
  return undefined;
}

// Options placed before the git subcommand, e.g. `git -C repo push`.
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function skipGitGlobalOptions(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += GIT_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  return args.slice(i);
}

function checkSegment(tokens: string[]): string | undefined {
  const [cmd, ...args] = stripPrefixes(tokens);
  if (!cmd) return undefined;
  const base = cmd.split("/").pop() ?? cmd;
  if (base === "rm") return checkRm(args);
  if (base === "mkfs" || base.startsWith("mkfs.")) return "formatage de disque (mkfs)";
  if (base === "dd" && args.some((a) => /^of=\/dev\//.test(a)))
    return "écriture directe sur un disque (dd of=/dev/...)";
  if (base === "git") return checkGitPush(skipGitGlobalOptions(args));
  return undefined;
}

export function detectDestructiveCommand(command: string): DestructiveVerdict {
  // $HOME must stay recognizable as the home directory before variables are blanked out.
  const withHome = command.replace(/\$\{HOME\}|\$HOME\b/g, "~");
  const forms = [withHome.replace(/["']/g, "")];
  try {
    forms.push(canonicalizer.canonicalizeShell(withHome));
  } catch {
    // canonicalization is best effort; the quote-stripped form is still checked
  }
  for (const form of forms) {
    for (const segment of form.split(/&&|\|\||[;&|\n()]/)) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      const reason = checkSegment(tokens);
      if (reason) return { blocked: true, reason };
    }
  }
  return { blocked: false };
}
