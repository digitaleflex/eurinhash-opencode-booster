// src/cli/installer/commands.ts — tollfree init | update | uninstall | doctor

import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  accessSync,
  constants,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { configDir } from "../../core/paths";
import { KEY_ENV, FetchLike, bold, dim, green, red, yellow } from "../common";
import { parseJsonc, upsertTopLevelString } from "../jsonc";
import { DEFAULT_FALLBACK_MODEL, buildDesired, packageRoot, packageVersion } from "./assets";
import { Detected, PROVIDER_KEY, detectEnvironment } from "./detect";
import {
  ConfigEdit,
  MANIFEST_DIR,
  Manifest,
  applyPlan,
  computePlan,
  loadManifest,
  newManifest,
  saveManifest,
  sha256,
  uninstall,
} from "./plan";

export interface InstallerDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => Date;
  fetchImpl?: FetchLike;
  /** Package root holding agent/, command/, skills/, dist/; tests point this at a fixture. */
  assetsRoot?: string;
  opencodeVersion?: () => string | undefined;
  checkOllama?: boolean;
}

export function defaultInstallerDeps(): InstallerDeps {
  return {
    out: (l) => console.log(l),
    err: (l) => process.stderr.write(l + "\n"),
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
  };
}

const TARGET_OPTIONS = {
  project: { type: "boolean" },
  global: { type: "boolean" },
  dir: { type: "string" },
} as const;

/** --dir > --project (./.opencode) > the OpenCode config dir (honours TOLLFREE_DIR / XDG). */
export function resolveTarget(
  v: { project?: boolean; global?: boolean; dir?: string },
  d: InstallerDeps
): string {
  if (v.dir) return v.dir;
  if (v.project) return join(d.cwd, ".opencode");
  return configDir();
}

const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"];

function findConfig(dir: string): string | undefined {
  return CONFIG_NAMES.find((n) => existsSync(join(dir, n)));
}

/** Creates a minimal config, or (opt-in) adds default_agent to the user's. Never rewrites anything else. */
function ensureConfig(
  dir: string,
  o: { setDefault: boolean; dryRun: boolean },
  d: InstallerDeps
): { edit?: ConfigEdit; note: string } {
  const existing = findConfig(dir);
  if (!existing) {
    const text = `{\n  "$schema": "https://opencode.ai/config.json",\n  "default_agent": "tollfree"\n}\n`;
    if (!o.dryRun) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "opencode.jsonc"), text, "utf8");
    }
    return {
      edit: { file: "opencode.jsonc", kind: "created", sha256: sha256(text) },
      note: "created opencode.jsonc with default_agent = tollfree",
    };
  }

  const text = readFileSync(join(dir, existing), "utf8");
  let cfg: any;
  try {
    cfg = parseJsonc(text);
  } catch {
    return {
      note: `${existing} is not valid JSONC, left untouched (add "default_agent": "tollfree" yourself)`,
    };
  }
  if (cfg?.default_agent === "tollfree")
    return { note: `${existing} already uses the tollfree agent` };
  if (cfg?.default_agent) {
    return {
      note: `${existing} has default_agent = ${cfg.default_agent}, left unchanged (use @tollfree to call it)`,
    };
  }
  if (!o.setDefault) {
    return {
      note: `${existing} untouched; add "default_agent": "tollfree" or rerun with --set-default`,
    };
  }
  const up = upsertTopLevelString(text, "default_agent", "tollfree");
  if (!up) return { note: `${existing}: could not find the top-level object, left untouched` };
  if (!o.dryRun) writeFileSync(join(dir, existing), up.text, "utf8");
  return {
    edit: { file: existing, kind: "inserted", snippet: up.inserted },
    note: `added default_agent = tollfree to ${existing}`,
  };
}

const INSTALL_OPTIONS = {
  ...TARGET_OPTIONS,
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  "set-default": { type: "boolean" },
  "with-paid": { type: "boolean" },
  "fallback-model": { type: "string" },
} as const;

const INSTALL_HELP = `Usage: tollfree init|update [options]

  --global             Install in the OpenCode config dir (default; honours TOLLFREE_DIR / XDG_CONFIG_HOME)
  --project            Install in ./.opencode for this project only
  --dir <path>         Install in a specific directory
  --dry-run            Show what would change, write nothing
  --force              Overwrite files you edited or that already exist (a backup is kept)
  --set-default        Also set "default_agent": "tollfree" in an existing opencode.jsonc
  --with-paid          Include the paid worker-pro-* agents
  --fallback-model <m> Model for agents whose provider has no key (default ${DEFAULT_FALLBACK_MODEL})
`;

async function runInstall(
  mode: "init" | "update",
  argv: string[],
  d: InstallerDeps
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...INSTALL_OPTIONS, help: { type: "boolean", short: "h" } },
    });
  } catch (e) {
    d.err(`${(e as Error).message}\n\n${INSTALL_HELP}`);
    return 1;
  }
  const v = parsed.values;
  if (v.help) {
    d.out(INSTALL_HELP);
    return 0;
  }
  const dir = resolveTarget(v, d);
  const dryRun = Boolean(v["dry-run"]);
  const root = d.assetsRoot ?? packageRoot();
  const existing = loadManifest(dir);

  if (mode === "update" && !existing) {
    d.err(`No tollfree installation found in ${dir}. Run \`tollfree init\` first.`);
    return 1;
  }

  const detected = await detectEnvironment({
    dir,
    env: d.env,
    fetchImpl: d.fetchImpl,
    opencodeVersion: d.opencodeVersion,
    checkOllama: d.checkOllama,
  });
  const { files, notes } = buildDesired({
    root,
    detected,
    fallbackModel: v["fallback-model"] ?? DEFAULT_FALLBACK_MODEL,
    withPaid: Boolean(v["with-paid"]),
  });
  if (files.size === 0) {
    d.err(`No assets found in ${root}; is the package complete?`);
    return 1;
  }

  const manifest: Manifest = existing ?? newManifest(packageVersion(root), d.now());
  manifest.version = packageVersion(root);
  const actions = computePlan(dir, files, existing);
  const result = applyPlan(dir, actions, files, manifest, {
    force: Boolean(v.force),
    dryRun,
    now: d.now(),
  });

  let configNote = "";
  if (mode === "init" || v["set-default"]) {
    const cfg = ensureConfig(dir, { setDefault: Boolean(v["set-default"]), dryRun }, d);
    configNote = cfg.note;
    if (cfg.edit && !dryRun) manifest.config = cfg.edit;
  }
  if (!dryRun) saveManifest(dir, manifest);

  const count = (k: string) => actions.filter((a) => a.kind === k).length;
  d.out(bold(`tollfree ${mode}${dryRun ? " (dry run)" : ""} -> ${dir}`));
  d.out(
    `  ${green(String(count("add")))} new, ${green(String(count("update")))} updated, ${count("unchanged") + count("adopt")} unchanged, ${count("remove")} removed`
  );
  if (result.conflicts.length) {
    d.out(
      yellow(
        `  ${result.conflicts.length} file(s) skipped: already there and different (use --force to replace, a backup is kept):`
      )
    );
    for (const rel of result.conflicts) d.out(`    - ${rel}`);
  }
  if (result.keptModified.length) {
    d.out(
      yellow(
        `  ${result.keptModified.length} file(s) you edited are no longer shipped and were kept:`
      )
    );
    for (const rel of result.keptModified) d.out(`    - ${rel}`);
  }
  if (configNote) d.out(`  config: ${configNote}`);
  if (notes.length) {
    d.out("  adapted to this machine:");
    for (const n of notes) d.out(dim(`    - ${n}`));
  }

  const providers = Object.keys(detected.keys);
  d.out(
    `  keys found: ${providers.length ? providers.join(", ") : "none (free built-in models only)"}${detected.ollama ? "; Ollama running" : ""}`
  );
  if (!detected.tollfreeOnPath) {
    d.out(
      yellow(
        "  `tollfree` is not on PATH, but the agents run it: install it with `npm install -g tollfree`"
      )
    );
  }
  if (!detected.opencode.found)
    d.out(yellow("  OpenCode was not found on PATH: install it from https://opencode.ai"));
  if (mode === "init" && !dryRun) {
    d.out("");
    d.out(
      "Next: restart OpenCode, then run `tollfree doctor`. Add API keys as environment variables"
    );
    d.out(
      `(${Object.values(KEY_ENV)
        .slice(0, 5)
        .map((n) => n[0])
        .join(", ")}, ...) or key files in ${dir}, then \`tollfree update\`.`
    );
  }
  return 0;
}

export const runInit = (argv: string[], d = defaultInstallerDeps()) => runInstall("init", argv, d);
export const runUpdate = (argv: string[], d = defaultInstallerDeps()) =>
  runInstall("update", argv, d);

// ── uninstall ───────────────────────────────────────────────────────────────

const STATE_FILES = [
  "free-models.json",
  "free-test-report.json",
  "models-dev-cache.json",
  "route-usage.json",
  "provider_usage.json",
  "provider_circuit.json",
];

export async function runUninstall(argv: string[], d = defaultInstallerDeps()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        ...TARGET_OPTIONS,
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        purge: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    d.err((e as Error).message);
    return 1;
  }
  const v = parsed.values;
  if (v.help) {
    d.out(`Usage: tollfree uninstall [--global|--project|--dir <path>] [--dry-run] [--force] [--purge]

Removes only the files tollfree installed (those you edited are kept unless --force) and puts back
any file it replaced. --purge also deletes tollfree's state files (quota counters, probe results).
API key files are never touched.`);
    return 0;
  }
  const dir = resolveTarget(v, d);
  const manifest = loadManifest(dir);
  if (!manifest) {
    d.err(`No tollfree installation found in ${dir}.`);
    return 1;
  }
  const dryRun = Boolean(v["dry-run"]);
  const res = uninstall(dir, manifest, { force: Boolean(v.force), dryRun });

  let purged = 0;
  if (v.purge) {
    for (const f of STATE_FILES) {
      if (existsSync(join(dir, f))) {
        purged++;
        if (!dryRun) rmSync(join(dir, f), { force: true });
      }
    }
  }

  d.out(bold(`tollfree uninstall${dryRun ? " (dry run)" : ""} <- ${dir}`));
  d.out(
    `  ${res.removed.length} file(s) removed, ${res.restored.length} original(s) restored${v.purge ? `, ${purged} state file(s) purged` : ""}`
  );
  if (res.keptModified.length) {
    d.out(
      yellow(
        `  ${res.keptModified.length} file(s) kept because you edited them (use --force to remove):`
      )
    );
    for (const rel of res.keptModified) d.out(`    - ${rel}`);
  }
  if (res.configNote) d.out(`  config: ${res.configNote}`);
  if (!v.purge)
    d.out(dim("  state files (quota counters, probe results) kept; add --purge to delete them"));
  return 0;
}

// ── doctor ──────────────────────────────────────────────────────────────────

type Level = "ok" | "warn" | "fail";
interface Check {
  level: Level;
  name: string;
  detail: string;
}

export async function runDoctor(argv: string[], d = defaultInstallerDeps()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...TARGET_OPTIONS, json: { type: "boolean" } } });
  } catch (e) {
    d.err((e as Error).message);
    return 1;
  }
  const v = parsed.values;
  const dir = resolveTarget(v, d);
  const checks: Check[] = [];
  const add = (level: Level, name: string, detail: string) => checks.push({ level, name, detail });

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  add(
    nodeMajor >= 18 ? "ok" : "fail",
    "Node.js",
    `v${process.versions.node} on ${process.platform}${nodeMajor >= 18 ? "" : " (need >= 18)"}`
  );

  const detected: Detected = await detectEnvironment({
    dir,
    env: d.env,
    fetchImpl: d.fetchImpl,
    opencodeVersion: d.opencodeVersion,
    checkOllama: d.checkOllama,
  });
  add(
    detected.opencode.found ? "ok" : "warn",
    "OpenCode",
    detected.opencode.found
      ? `found (${detected.opencode.version})`
      : "not on PATH (https://opencode.ai)"
  );

  if (existsSync(dir)) {
    try {
      accessSync(dir, constants.W_OK);
      add("ok", "Config dir", `${dir} (writable)`);
    } catch {
      add("fail", "Config dir", `${dir} is not writable`);
    }
  } else add("warn", "Config dir", `${dir} does not exist yet (run \`tollfree init\`)`);

  const manifest = loadManifest(dir);
  if (!manifest) {
    add("warn", "Installation", "not installed here (run `tollfree init`)");
  } else {
    let missing = 0;
    let modified = 0;
    for (const [rel, { sha256: h }] of Object.entries(manifest.files)) {
      const p = join(dir, rel);
      if (!existsSync(p)) missing++;
      else if (sha256(readFileSync(p)) !== h) modified++;
    }
    const total = Object.keys(manifest.files).length;
    const level: Level = missing ? "fail" : modified ? "warn" : "ok";
    add(
      level,
      "Installation",
      `v${manifest.version}, ${total} files${missing ? `, ${missing} missing (run \`tollfree update --force\`)` : ""}${modified ? `, ${modified} edited by you (kept on update)` : ""}`
    );
    const shipped = packageVersion(d.assetsRoot ?? packageRoot());
    if (shipped !== manifest.version)
      add(
        "warn",
        "Version",
        `installed ${manifest.version}, package ${shipped} (run \`tollfree update\`)`
      );
  }

  const cfgFile = findConfig(dir);
  if (!cfgFile) add("warn", "opencode config", "no opencode.jsonc / opencode.json");
  else {
    try {
      const cfg = parseJsonc(readFileSync(join(dir, cfgFile), "utf8"));
      add(
        cfg?.default_agent === "tollfree" ? "ok" : "warn",
        cfgFile,
        cfg?.default_agent
          ? `default_agent = ${cfg.default_agent}`
          : "no default_agent (use @tollfree or --set-default)"
      );
    } catch {
      add("fail", cfgFile, "not valid JSONC");
    }
  }

  add(
    detected.tollfreeOnPath ? "ok" : "warn",
    "tollfree command",
    detected.tollfreeOnPath
      ? "on PATH"
      : "not on PATH; agents call it, install with `npm install -g tollfree`"
  );
  const keyList = Object.keys(PROVIDER_KEY);
  const found = keyList.filter((p) => p in detected.keys);
  add(
    found.length ? "ok" : "warn",
    "API keys",
    found.length
      ? found
          .map(
            (p) =>
              `${p} (${detected.keys[p].source}: ${detected.keys[p].detail.split(/[\\/]/).pop()})`
          )
          .join(", ")
      : "none found: only the free built-in models will work"
  );
  add(
    detected.ollama ? "ok" : "warn",
    "Ollama",
    detected.ollama ? "running on localhost:11434" : "not running (optional, local models)"
  );

  const fm = join(dir, "free-models.json");
  if (!existsSync(fm)) add("warn", "Probe", "never run (`tollfree probe`)");
  else {
    const age = Math.round((Date.now() - statSync(fm).mtimeMs) / 60000);
    add(age > 60 ? "warn" : "ok", "Probe", `free-models.json is ${age} min old`);
  }
  const plugin = existsSync(join(dir, "plugin", "tollfree-guard.js"));
  add(
    plugin ? "ok" : "warn",
    "Guard plugin",
    plugin ? "installed (blocks destructive commands, redacts secrets)" : "not installed"
  );

  const failed = checks.some((c) => c.level === "fail");
  if (v.json) {
    d.out(JSON.stringify({ dir, ok: !failed, checks }, null, 2));
    return failed ? 1 : 0;
  }
  const tag = { ok: green("[OK]  "), warn: yellow("[WARN]"), fail: red("[FAIL]") };
  d.out(bold(`tollfree doctor (${dir})`));
  for (const c of checks) d.out(`  ${tag[c.level]} ${c.name.padEnd(16)} ${c.detail}`);
  d.out("");
  d.out(
    failed
      ? red("Problems found.")
      : checks.some((c) => c.level === "warn")
        ? "No blocking problem; see the warnings above."
        : green("All good.")
  );
  return failed ? 1 : 0;
}
