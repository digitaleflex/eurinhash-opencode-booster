// src/cli/installer/plan.ts — Install engine: a manifest of what Tollfree wrote, a plan, and an apply step.
// Rules that make update/uninstall safe:
//   * only files recorded in the manifest are ever removed or updated
//   * a file the user edited (hash differs from the manifest) is kept unless --force, and then backed up
//   * a file that already existed and is not ours is never overwritten without --force (and is backed up)

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readJson } from "../common";
import { safeRel } from "./assets";

export const MANIFEST_DIR = ".tollfree";
export const MANIFEST_FILE = join(MANIFEST_DIR, "manifest.json");

export interface ConfigEdit {
  file: string;
  kind: "created" | "inserted";
  /** inserted: the exact text added; created: unused. */
  snippet?: string;
  /** created: hash of the file as we wrote it (to know whether the user changed it). */
  sha256?: string;
}

export interface Manifest {
  schema: 1;
  tool: "tollfree";
  version: string;
  installedAt: string;
  updatedAt: string;
  files: Record<string, { sha256: string }>;
  /** rel -> backup path (relative to the install dir) of the user's original file. */
  backups: Record<string, string>;
  config?: ConfigEdit;
}

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export function loadManifest(dir: string): Manifest | undefined {
  const m = readJson<Manifest>(join(dir, MANIFEST_FILE));
  return m && m.tool === "tollfree" && m.schema === 1 ? m : undefined;
}

export function saveManifest(dir: string, m: Manifest): void {
  const p = join(dir, MANIFEST_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2), "utf8");
}

export function newManifest(version: string, now: Date): Manifest {
  const t = now.toISOString();
  return {
    schema: 1,
    tool: "tollfree",
    version,
    installedAt: t,
    updatedAt: t,
    files: {},
    backups: {},
  };
}

export type ActionKind =
  | "add" //            new file
  | "update" //         ours, unmodified, new content
  | "unchanged" //      ours (or identical), nothing to do
  | "adopt" //          already there with the right content: just track it
  | "conflict" //       exists, differs, not ours or edited by the user
  | "remove" //         ours, unmodified, no longer shipped
  | "keep-modified"; // no longer shipped but the user edited it

export interface Action {
  rel: string;
  kind: ActionKind;
}

function currentHash(dir: string, rel: string): string | undefined {
  const p = join(dir, rel);
  return existsSync(p) ? sha256(readFileSync(p)) : undefined;
}

export function computePlan(
  dir: string,
  desired: Map<string, Buffer>,
  manifest: Manifest | undefined
): Action[] {
  const actions: Action[] = [];
  for (const [rel, content] of desired) {
    if (!safeRel(rel)) throw new Error(`Refusing unsafe path: ${rel}`);
    const want = sha256(content);
    const cur = currentHash(dir, rel);
    const tracked = manifest?.files[rel]?.sha256;
    if (cur === undefined) actions.push({ rel, kind: "add" });
    else if (tracked !== undefined && cur === tracked)
      actions.push({ rel, kind: want === cur ? "unchanged" : "update" });
    else if (cur === want) actions.push({ rel, kind: tracked === want ? "unchanged" : "adopt" });
    else actions.push({ rel, kind: "conflict" });
  }
  for (const [rel, { sha256: tracked }] of Object.entries(manifest?.files ?? {})) {
    if (desired.has(rel) || !safeRel(rel)) continue; // a tampered manifest must never reach outside the dir
    const cur = currentHash(dir, rel);
    if (cur === undefined) continue; // already gone
    actions.push({ rel, kind: cur === tracked ? "remove" : "keep-modified" });
  }
  return actions;
}

function backupFile(dir: string, rel: string, stamp: string, manifest: Manifest): void {
  if (manifest.backups[rel]) return; // keep the user's original, not a later backup of our own file
  const to = join(MANIFEST_DIR, "backup", stamp, rel);
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  copyFileSync(join(dir, rel), join(dir, to));
  manifest.backups[rel] = to;
}

function pruneEmptyDirs(dir: string, from: string): void {
  let d = dirname(join(dir, from));
  while (d.length > dir.length && existsSync(d) && readdirSync(d).length === 0) {
    rmdirSync(d);
    d = dirname(d);
  }
}

export interface ApplyResult {
  written: number;
  removed: number;
  conflicts: string[];
  keptModified: string[];
}

export function applyPlan(
  dir: string,
  actions: Action[],
  desired: Map<string, Buffer>,
  manifest: Manifest,
  o: { force: boolean; dryRun: boolean; now: Date }
): ApplyResult {
  const res: ApplyResult = { written: 0, removed: 0, conflicts: [], keptModified: [] };
  const stamp = o.now.toISOString().replace(/[:.]/g, "-");

  for (const { rel, kind } of actions) {
    const abs = join(dir, rel);
    switch (kind) {
      case "unchanged":
      case "adopt": {
        if (!o.dryRun) manifest.files[rel] = { sha256: sha256(desired.get(rel) as Buffer) };
        break;
      }
      case "add":
      case "update": {
        res.written++;
        if (o.dryRun) break;
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, desired.get(rel) as Buffer);
        manifest.files[rel] = { sha256: sha256(desired.get(rel) as Buffer) };
        break;
      }
      case "conflict": {
        if (!o.force) {
          res.conflicts.push(rel);
          break;
        }
        res.written++;
        if (o.dryRun) break;
        backupFile(dir, rel, stamp, manifest);
        writeFileSync(abs, desired.get(rel) as Buffer);
        manifest.files[rel] = { sha256: sha256(desired.get(rel) as Buffer) };
        break;
      }
      case "remove": {
        res.removed++;
        if (o.dryRun) break;
        rmSync(abs, { force: true });
        delete manifest.files[rel];
        pruneEmptyDirs(dir, rel);
        break;
      }
      case "keep-modified": {
        res.keptModified.push(rel);
        if (!o.dryRun) delete manifest.files[rel]; // no longer ours: stop tracking, leave the file
        break;
      }
    }
  }
  if (!o.dryRun) manifest.updatedAt = o.now.toISOString();
  return res;
}

export interface UninstallResult {
  removed: string[];
  keptModified: string[];
  restored: string[];
  configNote?: string;
}

/** Removes only what the manifest says we installed, restoring the user's originals from backup. */
export function uninstall(
  dir: string,
  manifest: Manifest,
  o: { force: boolean; dryRun: boolean }
): UninstallResult {
  const res: UninstallResult = { removed: [], keptModified: [], restored: [] };

  for (const [rel, { sha256: tracked }] of Object.entries(manifest.files)) {
    if (!safeRel(rel)) continue;
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    if (sha256(readFileSync(abs)) !== tracked && !o.force) {
      res.keptModified.push(rel);
      continue;
    }
    res.removed.push(rel);
    if (o.dryRun) continue;
    rmSync(abs, { force: true });
    const backup = manifest.backups[rel];
    if (backup && safeRel(backup.split("\\").join("/")) && existsSync(join(dir, backup))) {
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(join(dir, backup), abs);
      rmSync(join(dir, backup), { force: true });
      res.restored.push(rel);
    } else {
      pruneEmptyDirs(dir, rel);
    }
  }

  const cfg = manifest.config;
  if (cfg && safeRel(cfg.file)) {
    const abs = join(dir, cfg.file);
    if (existsSync(abs)) {
      const text = readFileSync(abs, "utf8");
      if (cfg.kind === "created") {
        if (sha256(text) === cfg.sha256 || o.force) {
          if (!o.dryRun) rmSync(abs, { force: true });
          res.configNote = `removed ${cfg.file} (created by tollfree)`;
        } else res.configNote = `kept ${cfg.file}: edited since install`;
      } else if (cfg.snippet && text.includes(cfg.snippet)) {
        if (!o.dryRun) writeFileSync(abs, text.replace(cfg.snippet, ""), "utf8");
        res.configNote = `removed the line tollfree added to ${cfg.file}`;
      } else res.configNote = `${cfg.file}: nothing to undo`;
    }
  }

  if (!o.dryRun) {
    rmSync(join(dir, MANIFEST_FILE), { force: true });
    const backupRoot = join(dir, MANIFEST_DIR, "backup");
    // drop empty backup folders; keep any backup whose file could not be restored
    pruneTree(backupRoot);
    if (existsSync(join(dir, MANIFEST_DIR)) && readdirSync(join(dir, MANIFEST_DIR)).length === 0) {
      rmdirSync(join(dir, MANIFEST_DIR));
    }
  }
  return res;
}

function pruneTree(p: string): boolean {
  if (!existsSync(p)) return true;
  let empty = true;
  for (const name of readdirSync(p)) {
    const child = join(p, name);
    if (statSync(child).isDirectory()) {
      if (!pruneTree(child)) empty = false;
    } else empty = false;
  }
  if (empty) rmdirSync(p);
  return empty;
}
