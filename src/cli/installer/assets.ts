// src/cli/installer/assets.ts — Builds the set of files Tollfree installs, adapted to this machine.
//
//   agent/*.md     role agents always; worker-* only when their provider works here;
//                  a role agent whose model needs a missing key falls back to a free built-in model
//   command/*.md   slash commands
//   skills/**      skills
//   plugin/*.js    bundled plugins (guard, audit-logger, auto-compact), built into dist/plugin

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Detected, providerAvailable } from "./detect";

export const DEFAULT_FALLBACK_MODEL = "opencode/deepseek-v4-flash";

/** Root of the installed package (or of the repo in development): holds agent/, command/, skills/, dist/. */
export function packageRoot(): string {
  // dist/cli/installer/assets.js and src/cli/installer/assets.ts are both three levels below the root.
  return join(__dirname, "..", "..", "..");
}

export function packageVersion(root = packageRoot()): string {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface AssetOptions {
  root: string;
  detected: Detected;
  fallbackModel: string;
  /** Include the paid worker-pro-* agents. */
  withPaid: boolean;
}

export interface Desired {
  files: Map<string, Buffer>;
  /** Human-readable adaptation notes ("worker-groq skipped: no Groq key"). */
  notes: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const MODEL_LINE = /^model:[ \t]*(\S+)[ \t]*$/m;

export function agentModel(markdown: string): string | undefined {
  const fm = FRONTMATTER.exec(markdown);
  return fm ? MODEL_LINE.exec(fm[1])?.[1] : undefined;
}

function withModel(markdown: string, model: string): string {
  const fm = FRONTMATTER.exec(markdown);
  if (!fm) return markdown;
  const body = fm[1].replace(MODEL_LINE, `model: ${model}`);
  return markdown.replace(fm[1], () => body);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__" || name === "node_modules" || name.startsWith(".DS_Store")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const posix = (p: string) => p.split(sep).join("/");

export function buildDesired(o: AssetOptions): Desired {
  const files = new Map<string, Buffer>();
  const notes: string[] = [];

  // agents
  for (const file of walk(join(o.root, "agent")).filter((f) => f.endsWith(".md"))) {
    const name = file.slice(file.lastIndexOf(sep) + 1, -3);
    let text = readFileSync(file, "utf8");
    const model = agentModel(text);
    const provider = model?.split("/")[0];

    if (name.startsWith("worker-")) {
      if (name.startsWith("worker-pro-") && !o.withPaid) {
        notes.push(`${name}: skipped (paid worker, use --with-paid)`);
        continue;
      }
      if (provider && !providerAvailable(provider, o.detected)) {
        const why = provider === "ollama" ? "Ollama is not running" : `no ${provider} key`;
        notes.push(`${name}: skipped (${why})`);
        continue;
      }
    } else if (model && provider && !providerAvailable(provider, o.detected)) {
      text = withModel(text, o.fallbackModel);
      notes.push(`${name}: model ${model} -> ${o.fallbackModel} (no ${provider} key)`);
    }
    files.set(`agent/${name}.md`, Buffer.from(text, "utf8"));
  }

  // commands
  for (const file of walk(join(o.root, "command")).filter((f) => f.endsWith(".md"))) {
    files.set(posix(relative(o.root, file)), readFileSync(file));
  }

  // skills (no tests, no provenance notes)
  for (const file of walk(join(o.root, "skills"))) {
    if (/\.test\.[tj]s$/.test(file) || file.endsWith(`${sep}INSTALLED.md`)) continue;
    files.set(posix(relative(o.root, file)), readFileSync(file));
  }

  // bundled plugins
  const pluginDir = join(o.root, "dist", "plugin");
  const bundles = walk(pluginDir).filter((f) => f.endsWith(".js"));
  if (bundles.length === 0)
    notes.push("plugins: not bundled (run `npm run build`), guardrail plugins not installed");
  for (const file of bundles) {
    files.set(`plugin/tollfree-${file.slice(file.lastIndexOf(sep) + 1)}`, readFileSync(file));
  }

  return { files, notes };
}

/** Refuses paths that would escape the install directory. */
export function safeRel(rel: string): boolean {
  return !!rel && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel) && !rel.split("/").includes("..");
}

export const dirnameOf = (rel: string) => posix(dirname(rel));
