// src/cli/audit-log.ts — Audit log viewer (ported from the former scripts/view-audit-log.py).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { logsDir } from "../core/paths";

type Entry = Record<string, any>;

export interface AuditFilters {
  tool?: string;
  agent?: string;
  provider?: string;
  model?: string;
  sensitive?: boolean;
  errors?: boolean;
  since?: Date;
  until?: Date;
}

const TAG = {
  ok: "[OK]",
  error: "[ERR]",
  failed: "[ERR]",
  sensitive: "[R]",
  agent: "[AGT]",
  tool: "[TL]",
} as const;

const present = (v: unknown) => v !== undefined && v !== null;

/** "HH:MM" (today) or "YYYY-MM-DD HH:MM", local time. */
export function parseTime(text: string, today = new Date()): Date | undefined {
  const full = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(text);
  if (full) return new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5]);
  const hm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hm) return new Date(today.getFullYear(), today.getMonth(), today.getDate(), +hm[1], +hm[2]);
  return undefined;
}

export function matchEntry(e: Entry, f: AuditFilters): boolean {
  if (f.tool && e.tool !== f.tool) return false;
  if (f.agent && e.agent !== f.agent) return false;
  if (f.provider && e.provider !== f.provider) return false;
  if (f.model && e.model !== f.model) return false;
  if (f.sensitive && !e.sensitive) return false;
  if (f.errors && !(present(e.error) || e.success === false)) return false;
  if (e.ts && (f.since || f.until)) {
    const t = new Date(e.ts).getTime();
    if (!Number.isNaN(t)) {
      if (f.since && t < f.since.getTime()) return false;
      if (f.until && t > f.until.getTime()) return false;
    }
  }
  return true;
}

export function formatEntry(e: Entry, asJson = false): string {
  if (asJson) return JSON.stringify(e);
  const ts = e.ts ?? "";
  const event = e.event ?? "";
  const sens = e.sensitive ? TAG.sensitive : "";
  let argsStr = JSON.stringify(e.args ?? {});
  if (argsStr.length > 120) argsStr = argsStr.slice(0, 120) + "...";

  let status = "";
  if (e.error) status = ` ${TAG.error} ${String(e.error).slice(0, 80)}`;
  else if (e.success === false) status = ` ${TAG.failed} failed`;
  else if (event === "tool.execute.after") status = ` ${TAG.ok}`;
  else if (e.sensitive) status = ` ${TAG.sensitive}`;

  if (event === "agent.invoked") {
    const model = e.model ? ` (${e.model})` : "";
    const provider = e.provider ? ` via ${e.provider}` : "";
    return `${ts} ${sens}${TAG.agent} ${e.agent ?? ""}${model}${provider}\n         task: ${String(e.task ?? "").slice(0, 80)}`;
  }
  if (event === "tool.execute.before" || event === "tool.execute.after") {
    return `${ts} ${sens}${TAG.tool} ${e.tool ?? ""} -> ${argsStr}${status}`;
  }
  let extra = "";
  if (e.model) extra += ` model=${e.model}`;
  if (e.provider) extra += ` provider=${e.provider}`;
  return `${ts} ${sens}${event}${extra} ${JSON.stringify(e).slice(0, 200)}`;
}

export interface Stats {
  total: number;
  by_event: Record<string, number>;
  by_tool: Record<string, number>;
  by_agent: Record<string, number>;
  by_provider: Record<string, number>;
  by_model: Record<string, number>;
  errors: number;
  blocked: number;
  sensitive: number;
  success: number;
}

export function computeStatistics(entries: Entry[]): Stats {
  const s: Stats = {
    total: 0,
    by_event: {},
    by_tool: {},
    by_agent: {},
    by_provider: {},
    by_model: {},
    errors: 0,
    blocked: 0,
    sensitive: 0,
    success: 0,
  };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  for (const e of entries) {
    s.total++;
    bump(s.by_event, e.event ?? "unknown");
    bump(s.by_tool, e.tool ?? "unknown");
    bump(s.by_agent, e.agent ?? "unknown");
    if (e.provider) bump(s.by_provider, e.provider);
    if (e.model) bump(s.by_model, e.model);
    if (present(e.error)) s.errors++;
    if (e.success === false) s.errors++;
    if (e.blocked === true) s.blocked++;
    if (e.sensitive === true) s.sensitive++;
    if (e.success === true) s.success++;
  }
  return s;
}

function printStatistics(s: Stats, out: (l: string) => void): void {
  const section = (title: string, m: Record<string, number>) => {
    out(`--- ${title} ---`);
    for (const [k, n] of Object.entries(m).sort((a, b) => b[1] - a[1])) out(`  ${k}: ${n}`);
    out("");
  };
  out("=== Audit Log Statistics ===");
  out(`Total entries: ${s.total}`);
  out("");
  section("By Event", s.by_event);
  section("By Tool", s.by_tool);
  section("By Agent", s.by_agent);
  if (Object.keys(s.by_provider).length) section("By Provider", s.by_provider);
  if (Object.keys(s.by_model).length) section("By Model", s.by_model);
  out("--- Status ---");
  out(`  Successful: ${s.success}`);
  out(`  Errors:     ${s.errors}`);
  out(`  Blocked:    ${s.blocked}`);
  out(`  Sensitive:  ${s.sensitive}`);
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function runAuditLog(
  argv: string[],
  dir = logsDir(),
  out: (l: string) => void = console.log
): Promise<number> {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      date: { type: "string" },
      tool: { type: "string" },
      agent: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      sensitive: { type: "boolean" },
      errors: { type: "boolean" },
      limit: { type: "string", default: "50" },
      all: { type: "boolean" },
      since: { type: "string" },
      until: { type: "string" },
      statistics: { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const limit = parseInt(a.limit as string, 10) || 50;
  const filters: AuditFilters = {
    tool: a.tool,
    agent: a.agent,
    provider: a.provider,
    model: a.model,
    sensitive: a.sensitive,
    errors: a.errors,
    since: a.since ? parseTime(a.since) : undefined,
    until: a.until ? parseTime(a.until) : undefined,
  };

  let files: string[] = [];
  if (a.all) {
    files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^audit-.*\.jsonl$/.test(f))
          .sort()
          .reverse()
          .map((f) => join(dir, f))
      : [];
  } else {
    const file = join(dir, `audit-${a.date ?? localDate()}.jsonl`);
    files = existsSync(file) ? [file] : [];
  }

  if (files.length === 0) {
    out(`[audit-log] No log files found in ${dir}`);
    out("  (use --date YYYY-MM-DD or --all to see older logs)");
    return 0;
  }

  const entries: Entry[] = [];
  let shown = 0;
  outer: for (const file of files) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e: Entry;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!matchEntry(e, filters)) continue;
      entries.push(e);
      if (!a.statistics) {
        out(formatEntry(e, a.json));
        if (++shown >= limit) break outer;
      }
    }
  }

  if (a.statistics) printStatistics(computeStatistics(entries), out);
  else if (entries.length === 0) {
    out("[audit-log] No matching entries found");
    out(`  Logs in: ${dir}`);
    out("  Try: --all to see all dates, or --limit 100 for more entries");
  }
  return 0;
}
