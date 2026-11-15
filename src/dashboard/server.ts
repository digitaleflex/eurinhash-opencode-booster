// src/dashboard/server.ts — TOLLFREE Command Center: a small local web dashboard.
// Zero dependencies (node:http), Node >= 18 and Bun. Safe by construction:
//   - binds to 127.0.0.1 only;
//   - every /api call needs a random per-process token (blocks CSRF from other web pages);
//   - the Host header must be local (blocks DNS rebinding);
//   - file access is confined to the project (WorkspaceGuard);
//   - terminal commands go through the destructive-command detector;
//   - chat only executes on a worker when `execute` is enabled (never an implicit network call).

import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceGuard } from "../core/confinement";
import { detectDestructiveCommand } from "../core/destructive-command";
import { GovernanceOrchestrator } from "../core/orchestrator";
import { configDir } from "../core/paths";
import { VERSION } from "../core/version";
import { WorkerExecutor, defaultWorkerExecutor } from "../core/worker-client";
import { readJson } from "../cli/common";
import { readMode } from "../cli/quota";
import { renderPage } from "./ui";

export const DEFAULT_PORT = 4321;
const MAX_BODY = 64 * 1024;
const TREE_SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

export interface DashboardOptions {
  /** Project directory exposed by the dashboard. */
  projectDir: string;
  /** Config dir holding free-models.json / mode.json (default: the OpenCode config dir). */
  configDir?: string;
  /** Fixed token (tests); random by default. */
  token?: string;
  /** When true, APPROVED chat tasks are executed on a free worker (uses network/quota). */
  execute?: boolean;
  /** Injected worker executor (tests). Overrides `execute`. */
  executor?: WorkerExecutor | null;
}

export interface Dashboard {
  server: Server;
  token: string;
  /** Start listening; resolves with the actual port (use port 0 for a free one). */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

interface Json {
  [key: string]: unknown;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? (JSON.parse(text) as Json) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function git(cwd: string, args: string[], timeout = 10_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || (err ? String(err.message) : "")).toString() });
    });
  });
}

function shell(cwd: string, command: string, timeout = 15_000): Promise<Json> {
  const isWin = process.platform === "win32";
  const [bin, args] = isWin ? ["cmd", ["/d", "/s", "/c", command]] : ["sh", ["-c", command]];
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function parseGitStatus(porcelain: string): Array<{ status: string; path: string }> {
  return porcelain
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));
}

export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDashboard(opts: DashboardOptions): Dashboard {
  const projectDir = opts.projectDir;
  const cfgDir = opts.configDir ?? configDir();
  const token = opts.token ?? randomBytes(24).toString("hex");
  const guard = new WorkspaceGuard(projectDir);
  const executor =
    opts.executor !== undefined ? opts.executor : opts.execute ? defaultWorkerExecutor() : null;
  const orchestrator = new GovernanceOrchestrator(undefined, null, executor);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLocalHost(req.headers.host)) return send(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/") {
      return send(res, 200, renderPage(VERSION), "text/html");
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (!tokenOk(req.headers["x-tollfree-token"] as string | undefined, token)) {
      return send(res, 401, { error: "missing or invalid token" });
    }

    if (method === "GET" && url.pathname === "/api/system") {
      const total = totalmem();
      return send(res, 200, {
        version: VERSION,
        platform: process.platform,
        node: process.version,
        uptimeSec: Math.round(uptime()),
        cpuCount: cpus().length,
        load1: loadavg()[0],
        memTotalMb: Math.round(total / 1048576),
        memUsedMb: Math.round((total - freemem()) / 1048576),
        project: projectDir,
        executeEnabled: executor !== null,
      });
    }

    if (method === "GET" && url.pathname === "/api/workers") {
      const probe = readJson<{
        updated_human?: string;
        models?: Record<string, string>;
        latencies_ms?: Record<string, number>;
      }>(join(cfgDir, "free-models.json"));
      return send(res, 200, {
        mode: readMode(cfgDir).mode,
        updated: probe?.updated_human ?? null,
        workers: Object.entries(probe?.models ?? {}).map(([id, state]) => ({
          id,
          state,
          latencyMs: probe?.latencies_ms?.[id] ?? null,
        })),
      });
    }

    if (method === "GET" && url.pathname === "/api/git") {
      const inside = await git(projectDir, ["rev-parse", "--is-inside-work-tree"]);
      if (!inside.ok || inside.out.trim() !== "true") {
        return send(res, 200, { repo: false, branch: null, files: [] });
      }
      const branch = await git(projectDir, ["branch", "--show-current"]);
      const status = await git(projectDir, ["status", "--porcelain"]);
      return send(res, 200, {
        repo: true,
        branch: branch.out.trim() || "(detached HEAD)",
        files: parseGitStatus(status.out),
      });
    }

    if (method === "POST" && url.pathname === "/api/git/commit") {
      const body = await readBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 500)
        return send(res, 400, { error: "message required (max 500 chars)" });
      const add = await git(projectDir, ["add", "-A"]);
      if (!add.ok) return send(res, 500, { error: add.out });
      const commit = await git(projectDir, ["commit", "-m", message]);
      return send(res, commit.ok ? 200 : 409, { ok: commit.ok, output: commit.out });
    }

    if (method === "GET" && url.pathname === "/api/tree") {
      const rel = url.searchParams.get("path") ?? ".";
      const checked = guard.resolve(rel);
      if (!checked.allowed)
        return send(res, 403, { error: checked.reason ?? "path outside project" });
      if (!existsSync(checked.real) || !statSync(checked.real).isDirectory()) {
        return send(res, 404, { error: "not a directory" });
      }
      const entries = readdirSync(checked.real, { withFileTypes: true })
        .filter((e) => !TREE_SKIP.has(e.name))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      return send(res, 200, { path: rel, entries });
    }

    if (method === "POST" && url.pathname === "/api/terminal") {
      const body = await readBody(req);
      const command = typeof body.command === "string" ? body.command.trim() : "";
      if (!command || command.length > 2000)
        return send(res, 400, { error: "command required (max 2000 chars)" });
      const verdict = detectDestructiveCommand(command);
      if (verdict.blocked)
        return send(res, 403, { blocked: true, reason: verdict.reason ?? "blocked by guard" });
      return send(res, 200, await shell(projectDir, command));
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      const body = await readBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 8000)
        return send(res, 400, { error: "message required (max 8000 chars)" });
      const result = await orchestrator.execute({ description: message });
      return send(res, 200, result);
    }

    return send(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) send(res, msg === "body too large" ? 413 : 400, { error: msg });
      else res.end();
    });
  });

  return {
    server,
    token,
    listen: (port = DEFAULT_PORT) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Entry point used by `tollfree dashboard` and by /dashboard. */
export async function runDashboard(argv: string[]): Promise<number> {
  const execute = argv.includes("--execute");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const projectDir = resolve(positional[0] ?? process.env.TOLLFREE_DASHBOARD_DIR ?? process.cwd());
  const port = Number(process.env.TOLLFREE_DASHBOARD_PORT ?? DEFAULT_PORT);
  if (!existsSync(projectDir)) {
    console.error(`dashboard: directory not found: ${projectDir}`);
    return 1;
  }
  const dash = createDashboard({ projectDir, execute });
  let actual: number;
  try {
    actual = await dash.listen(port);
  } catch (e) {
    console.error(`dashboard: cannot listen on ${port}: ${(e as Error).message}`);
    console.error("Try TOLLFREE_DASHBOARD_PORT=9999");
    return 1;
  }
  console.log(`TOLLFREE Command Center → http://localhost:${actual}/#${dash.token}`);
  console.log(
    `project: ${projectDir}${execute ? "  (worker execution ON)" : "  (verdict only; --execute to run workers)"}`
  );
  console.log("Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await dash.close();
  return 0;
}
