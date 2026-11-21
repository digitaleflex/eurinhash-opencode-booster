import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Dashboard, createDashboard, isLocalHost, parseGitStatus } from "./server";
import { renderPage } from "./ui";

const TOKEN = "test-token";
let dash: Dashboard;
let base: string;
let project: string;
let cfg: string;

async function call(path: string, init: RequestInit & { token?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token !== null) headers["x-tollfree-token"] = init.token ?? TOKEN;
  const res = await fetch(base + path, {
    ...init,
    headers: { ...headers, ...(init.headers as object) },
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text };
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "tollfree-dash-"));
  cfg = mkdtempSync(join(tmpdir(), "tollfree-dashcfg-"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "a.txt"), "hello");
  writeFileSync(
    join(cfg, "free-models.json"),
    JSON.stringify({
      updated_human: "now",
      models: { "worker-groq": "ok", "worker-zhipu": "error" },
      latencies_ms: { "worker-groq": 120 },
    })
  );
  dash = createDashboard({ projectDir: project, configDir: cfg, token: TOKEN, executor: null });
  base = `http://127.0.0.1:${await dash.listen(0)}`;
});
afterEach(() => dash.close());

describe("dashboard security", () => {
  test("serves the page without a token", async () => {
    const r = await call("/", { token: null });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Tollfree Command Center");
  });

  test("rejects /api without or with a wrong token", async () => {
    expect((await call("/api/system", { token: null })).status).toBe(401);
    expect((await call("/api/system", { token: "nope" })).status).toBe(401);
  });

  test("rejects a non-local Host header (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: Number(new URL(base).port),
          path: "/",
          headers: { host: "evil.example" },
        },
        (res) => resolve(res.statusCode ?? 0)
      );
      req.end();
    });
    expect(status).toBe(403);
  });

  test("unknown routes return 404", async () => {
    expect((await call("/api/nope")).status).toBe(404);
    expect((await call("/other", { token: null })).status).toBe(404);
  });

  test("isLocalHost", () => {
    expect(isLocalHost("localhost:4321")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("[::1]:80")).toBe(true);
    expect(isLocalHost("evil.example")).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });
});

describe("dashboard api", () => {
  test("system", async () => {
    const r = await call("/api/system");
    expect(r.status).toBe(200);
    expect(r.json.project).toBe(project);
    expect(r.json.executeEnabled).toBe(false);
  });

  test("workers reads free-models.json", async () => {
    const r = await call("/api/workers");
    expect(r.json.mode).toBe("free");
    expect(r.json.workers).toEqual([
      { id: "worker-groq", state: "ok", latencyMs: 120 },
      { id: "worker-zhipu", state: "error", latencyMs: null },
    ]);
  });

  test("tree lists the project and blocks escapes", async () => {
    const ok = await call("/api/tree?path=.");
    expect(ok.json.entries.map((e: { name: string }) => e.name)).toEqual(["src", "a.txt"]);
    expect((await call("/api/tree?path=../..")).status).toBe(403);
    expect((await call("/api/tree?path=a.txt")).status).toBe(404);
  });

  test("terminal runs a safe command and blocks a destructive one", async () => {
    const ok = await call("/api/terminal", {
      method: "POST",
      body: JSON.stringify({ command: "echo hi" }),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.stdout).toContain("hi");
    expect(ok.json.exitCode).toBe(0);
    const bad = await call("/api/terminal", {
      method: "POST",
      body: JSON.stringify({ command: "rm -rf /" }),
    });
    expect(bad.status).toBe(403);
    expect(bad.json.blocked).toBe(true);
    const empty = await call("/api/terminal", { method: "POST", body: JSON.stringify({}) });
    expect(empty.status).toBe(400);
  });

  test("invalid JSON body is a 400", async () => {
    const r = await call("/api/terminal", { method: "POST", body: "{not json" });
    expect(r.status).toBe(400);
  });

  test("chat returns a governance verdict without executing", async () => {
    const r = await call("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "fix typo in readme" }),
    });
    expect(r.status).toBe(200);
    expect(["APPROVED", "BLOCKED", "REJECTED"]).toContain(r.json.verdict);
    expect(r.json.output).toBeUndefined();
    expect((await call("/api/chat", { method: "POST", body: JSON.stringify({}) })).status).toBe(
      400
    );
  });

  test("git: not a repo, then status and commit", async () => {
    const none = await call("/api/git");
    // tmpdir may sit inside no repo; either way the call must not fail
    expect(none.status).toBe(200);

    const run = (...a: string[]) => execFileSync("git", a, { cwd: project, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    const st = await call("/api/git");
    expect(st.json.repo).toBe(true);
    expect(st.json.files.length).toBeGreaterThan(0);
    const c = await call("/api/git/commit", {
      method: "POST",
      body: JSON.stringify({ message: "init" }),
    });
    expect(c.json.ok).toBe(true);
    expect(
      (await call("/api/git/commit", { method: "POST", body: JSON.stringify({}) })).status
    ).toBe(400);
  });
});

describe("helpers", () => {
  test("parseGitStatus", () => {
    expect(parseGitStatus(" M a.ts\n?? b.ts\n")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "??", path: "b.ts" },
    ]);
  });

  test("renderPage embeds the version and has no external asset", () => {
    const html = renderPage("9.9.9");
    expect(html).toContain("v9.9.9");
    expect(html).not.toMatch(/https?:\/\//);
  });
});
