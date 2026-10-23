import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc, upsertTopLevelString } from "../jsonc";
import { agentModel, buildDesired, safeRel } from "./assets";
import { runDoctor, runInit, runUninstall, runUpdate, InstallerDeps } from "./commands";
import { Detected } from "./detect";
import { loadManifest } from "./plan";

const tmp = (p = "tollfree-inst-") => mkdtempSync(join(tmpdir(), p));

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

/** A tiny package: 2 role agents (one needing a Zhipu key), 3 workers (one paid), a command, a skill, a bundled plugin. */
function fixtureRoot(version = "1.0.0") {
  const root = tmp("tollfree-assets-");
  put(root, "package.json", JSON.stringify({ name: "tollfree", version }));
  put(
    root,
    "agent/tollfree.md",
    "---\ndescription: supervisor\nmodel: opencode/deepseek-v4-flash\n---\nbody\n"
  );
  put(
    root,
    "agent/security.md",
    "---\ndescription: security\nmodel: zhipu/glm-4.7-flash\n---\nmodel: stays in body\n"
  );
  put(root, "agent/worker-groq.md", "---\nmodel: groq/qwen/qwen3.8-27b\n---\n");
  put(root, "agent/worker-pollinations.md", "---\nmodel: pollinations/openai\n---\n");
  put(root, "agent/worker-pro-openrouter.md", "---\nmodel: openrouter/openai/gpt-4o-mini\n---\n");
  put(root, "command/quota.md", "---\ndescription: quota\n---\n`tollfree quota`\n");
  put(root, "skills/tollfree-verification/SKILL.md", "# skill\n");
  put(root, "skills/tollfree-verification/scripts/x.test.ts", "// not shipped\n");
  put(root, "skills/INSTALLED.md", "provenance\n");
  put(root, "dist/plugin/guard.js", "export default async () => ({});\n");
  return root;
}

interface Harness {
  deps: InstallerDeps;
  out: string[];
  err: string[];
  dir: string;
  root: string;
  env: NodeJS.ProcessEnv;
}

function harness(opts: { env?: NodeJS.ProcessEnv; root?: string; ollama?: boolean } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const dir = tmp("tollfree-target-");
  const root = opts.root ?? fixtureRoot();
  const env = opts.env ?? {};
  let t = Date.UTC(2026, 9, 1, 12, 0, 0);
  const deps: InstallerDeps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
    cwd: dir,
    now: () => new Date((t += 1000)),
    assetsRoot: root,
    opencodeVersion: () => "1.2.3",
    fetchImpl: async () => new Response("{}", { status: opts.ollama ? 200 : 500 }),
  };
  return { deps, out, err, dir, root, env };
}

const files = (dir: string, sub = ""): string[] =>
  existsSync(join(dir, sub))
    ? readdirSync(join(dir, sub), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(dir, join(sub, e.name)) : [join(sub, e.name).split("\\").join("/")]
      )
    : [];

describe("assets", () => {
  const none: Detected = {
    platform: "linux",
    node: "22",
    opencode: { found: false },
    ollama: false,
    tollfreeOnPath: false,
    keys: {},
  };

  test("adapts agents to the machine and skips files that should not ship", () => {
    const root = fixtureRoot();
    const { files: f, notes } = buildDesired({
      root,
      detected: none,
      fallbackModel: "opencode/x",
      withPaid: false,
    });
    expect([...f.keys()].sort()).toEqual([
      "agent/security.md",
      "agent/tollfree.md",
      "agent/worker-pollinations.md",
      "command/quota.md",
      "plugin/tollfree-guard.js",
      "skills/tollfree-verification/SKILL.md",
    ]);
    // role agent keeps existing but falls back; body text mentioning "model:" is untouched
    const security = f.get("agent/security.md")!.toString();
    expect(agentModel(security)).toBe("opencode/x");
    expect(security).toContain("model: stays in body");
    expect(notes.join("\n")).toContain("worker-groq: skipped (no groq key)");
    expect(notes.join("\n")).toContain("worker-pro-openrouter: skipped (paid worker");
  });

  test("keys and --with-paid bring workers back", () => {
    const root = fixtureRoot();
    const keys = {
      groq: { source: "env" as const, detail: "GROQ_API_KEY" },
      zhipu: { source: "file" as const, detail: "x" },
      openrouter: { source: "env" as const, detail: "OPENROUTER_API_KEY" },
    };
    const { files: f } = buildDesired({
      root,
      detected: { ...none, keys },
      fallbackModel: "opencode/x",
      withPaid: true,
    });
    expect(f.has("agent/worker-groq.md")).toBe(true);
    expect(f.has("agent/worker-pro-openrouter.md")).toBe(true);
    expect(agentModel(f.get("agent/security.md")!.toString())).toBe("zhipu/glm-4.7-flash");
  });

  test("safeRel blocks traversal", () => {
    expect(safeRel("agent/a.md")).toBe(true);
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", ""])
      expect(safeRel(bad)).toBe(false);
  });

  test("the real repo assets build: supervisor present, key-less workers absent, no tests shipped", () => {
    const { files: f, notes } = buildDesired({
      root: process.cwd(),
      detected: none,
      fallbackModel: "opencode/deepseek-v4-flash",
      withPaid: false,
    });
    expect(f.has("agent/tollfree.md")).toBe(true);
    expect(f.has("agent/worker-groq.md")).toBe(false);
    expect(f.has("agent/worker-opencode.md")).toBe(true);
    expect([...f.keys()].some((k) => /\.test\.[tj]s$/.test(k))).toBe(false);
    expect(f.has("skills/INSTALLED.md")).toBe(false);
    for (const [rel, buf] of f)
      if (rel.startsWith("agent/") && !rel.includes("worker-"))
        expect(agentModel(buf.toString())).toMatch(/^opencode\//);
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe("jsonc upsert", () => {
  test("inserts after the opening brace, keeps comments, and the result parses", () => {
    const src = `// my config\n{\n  // theme\n  "theme": "dark", /* inline */\n  "plugin": []\n}\n`;
    const up = upsertTopLevelString(src, "default_agent", "tollfree")!;
    expect(up.text).toContain("// my config");
    expect(up.text).toContain("// theme");
    expect(parseJsonc(up.text).default_agent).toBe("tollfree");
    expect(up.text.replace(up.inserted, "")).toBe(src);
  });
  test("empty object gets no trailing comma; existing key is replaced; non-object refused", () => {
    expect(parseJsonc(upsertTopLevelString("{}", "k", "v")!.text)).toEqual({ k: "v" });
    expect(upsertTopLevelString('{ "k": "old" }', "k", "new")!.text).toContain('"k": "new"');
    expect(upsertTopLevelString("[]", "k", "v")).toBeUndefined();
  });
});

describe("init / update / uninstall", () => {
  test("fresh init installs the adapted set, creates a minimal config and a manifest", async () => {
    const h = harness();
    expect(await runInit(["--dir", h.dir], h.deps)).toBe(0);
    expect(
      files(h.dir)
        .filter((f) => !f.startsWith(".tollfree/"))
        .sort()
    ).toEqual([
      "agent/security.md",
      "agent/tollfree.md",
      "agent/worker-pollinations.md",
      "command/quota.md",
      "opencode.jsonc",
      "plugin/tollfree-guard.js",
      "skills/tollfree-verification/SKILL.md",
    ]);
    expect(parseJsonc(readFileSync(join(h.dir, "opencode.jsonc"), "utf8")).default_agent).toBe(
      "tollfree"
    );
    const m = loadManifest(h.dir)!;
    expect(Object.keys(m.files).length).toBe(6);
    expect(m.config?.kind).toBe("created");
    expect(h.out.join("\n")).toContain("6 new");
  });

  test("a second init changes nothing", async () => {
    const h = harness();
    await runInit(["--dir", h.dir], h.deps);
    h.out.length = 0;
    await runInit(["--dir", h.dir], h.deps);
    expect(h.out.join("\n")).toContain("0 new, 0 updated, 6 unchanged");
  });

  test("--dry-run writes nothing", async () => {
    const h = harness();
    await runInit(["--dir", h.dir, "--dry-run"], h.deps);
    expect(files(h.dir)).toEqual([]);
    expect(h.out[0]).toContain("dry run");
  });

  test("update ships new content but never overwrites a file the user edited", async () => {
    const h = harness();
    await runInit(["--dir", h.dir], h.deps);
    writeFileSync(join(h.dir, "agent/security.md"), "my own edit\n");
    put(h.root, "agent/tollfree.md", "---\nmodel: opencode/deepseek-v4-flash\n---\nNEW BODY\n");
    put(h.root, "agent/security.md", "---\nmodel: opencode/glm-5\n---\nupstream change\n");
    put(h.root, "package.json", JSON.stringify({ version: "1.1.0" }));
    h.out.length = 0;
    expect(await runUpdate(["--dir", h.dir], h.deps)).toBe(0);
    expect(readFileSync(join(h.dir, "agent/tollfree.md"), "utf8")).toContain("NEW BODY");
    expect(readFileSync(join(h.dir, "agent/security.md"), "utf8")).toBe("my own edit\n");
    expect(h.out.join("\n")).toContain("1 updated");
    expect(h.out.join("\n")).toContain("agent/security.md");
    expect(loadManifest(h.dir)!.version).toBe("1.1.0");
  });

  test("update follows your keys: a new key brings a worker, losing it removes the worker", async () => {
    const h = harness({ env: { GROQ_API_KEY: "g" } });
    await runInit(["--dir", h.dir], h.deps);
    expect(existsSync(join(h.dir, "agent/worker-groq.md"))).toBe(true);
    delete h.env.GROQ_API_KEY;
    await runUpdate(["--dir", h.dir], h.deps);
    expect(existsSync(join(h.dir, "agent/worker-groq.md"))).toBe(false);
  });

  test("a pre-existing different file is not ours: skipped, and --force backs it up", async () => {
    const h = harness();
    put(h.dir, "agent/tollfree.md", "someone else's agent\n");
    await runInit(["--dir", h.dir], h.deps);
    expect(readFileSync(join(h.dir, "agent/tollfree.md"), "utf8")).toBe("someone else's agent\n");
    expect(h.out.join("\n")).toContain("skipped");

    await runInit(["--dir", h.dir, "--force"], h.deps);
    expect(readFileSync(join(h.dir, "agent/tollfree.md"), "utf8")).toContain(
      "description: supervisor"
    );
    const m = loadManifest(h.dir)!;
    expect(readFileSync(join(h.dir, m.backups["agent/tollfree.md"]), "utf8")).toBe(
      "someone else's agent\n"
    );

    // uninstall puts the original back
    await runUninstall(["--dir", h.dir], h.deps);
    expect(readFileSync(join(h.dir, "agent/tollfree.md"), "utf8")).toBe("someone else's agent\n");
  });

  test("uninstall removes only what we installed, keeps edits, leaves state unless --purge", async () => {
    const h = harness();
    put(h.dir, "agent/mine.md", "user's own agent\n");
    put(h.dir, ".groq-key", "SECRET\n");
    await runInit(["--dir", h.dir], h.deps);
    writeFileSync(join(h.dir, "command/quota.md"), "edited\n");
    writeFileSync(join(h.dir, "free-models.json"), "{}");
    h.out.length = 0;
    expect(await runUninstall(["--dir", h.dir], h.deps)).toBe(0);
    expect(files(h.dir).sort()).toEqual(
      ["agent/mine.md", ".groq-key", "command/quota.md", "free-models.json"].sort()
    );
    expect(h.out.join("\n")).toContain("command/quota.md");
    expect(loadManifest(h.dir)).toBeUndefined();

    // second run: nothing installed
    expect(await runUninstall(["--dir", h.dir], h.deps)).toBe(1);
  });

  test("--purge also removes state files but never key files", async () => {
    const h = harness();
    put(h.dir, ".groq-key", "SECRET\n");
    await runInit(["--dir", h.dir], h.deps);
    writeFileSync(join(h.dir, "route-usage.json"), "{}");
    await runUninstall(["--dir", h.dir, "--purge"], h.deps);
    expect(files(h.dir)).toEqual([".groq-key"]);
  });

  test("--set-default edits an existing config minimally and uninstall undoes exactly that", async () => {
    const h = harness();
    const original = `// keep me\n{\n  "theme": "dark"\n}\n`;
    put(h.dir, "opencode.jsonc", original);
    await runInit(["--dir", h.dir], h.deps);
    expect(readFileSync(join(h.dir, "opencode.jsonc"), "utf8")).toBe(original); // untouched by default
    expect(h.out.join("\n")).toContain("--set-default");

    await runUpdate(["--dir", h.dir, "--set-default"], h.deps);
    const edited = readFileSync(join(h.dir, "opencode.jsonc"), "utf8");
    expect(edited).toContain("// keep me");
    expect(parseJsonc(edited)).toEqual({ theme: "dark", default_agent: "tollfree" });

    await runUninstall(["--dir", h.dir], h.deps);
    expect(readFileSync(join(h.dir, "opencode.jsonc"), "utf8")).toBe(original);
  });

  test("another default_agent is respected", async () => {
    const h = harness();
    put(h.dir, "opencode.json", '{ "default_agent": "build" }');
    await runInit(["--dir", h.dir, "--set-default"], h.deps);
    expect(readFileSync(join(h.dir, "opencode.json"), "utf8")).toBe('{ "default_agent": "build" }');
    expect(h.out.join("\n")).toContain("left unchanged");
  });

  test("a tampered manifest cannot make uninstall touch files outside the install dir", async () => {
    const h = harness();
    await runInit(["--dir", h.dir], h.deps);
    const outside = join(tmp("tollfree-outside-"), "victim.txt");
    writeFileSync(outside, "keep me");
    const m = JSON.parse(readFileSync(join(h.dir, ".tollfree/manifest.json"), "utf8"));
    const rel = "../../../.." + outside;
    m.files[rel] = { sha256: "x" };
    m.config = { file: rel, kind: "created", sha256: "x" };
    writeFileSync(join(h.dir, ".tollfree/manifest.json"), JSON.stringify(m));
    await runUninstall(["--dir", h.dir, "--force"], h.deps);
    expect(readFileSync(outside, "utf8")).toBe("keep me");
  });

  test("--project targets ./.opencode; update/uninstall without an install fail clearly", async () => {
    const h = harness();
    await runInit(["--project"], h.deps);
    expect(existsSync(join(h.dir, ".opencode", "agent", "tollfree.md"))).toBe(true);
    const empty = harness();
    expect(await runUpdate(["--dir", empty.dir], empty.deps)).toBe(1);
    expect(empty.err[0]).toContain("tollfree init");
    expect(await runUninstall(["--dir", empty.dir], empty.deps)).toBe(1);
  });
});

describe("doctor", () => {
  test("reports a healthy install, then flags a deleted file", async () => {
    const h = harness({ env: { GROQ_API_KEY: "g" }, ollama: true });
    await runInit(["--dir", h.dir], h.deps);
    h.out.length = 0;
    expect(await runDoctor(["--dir", h.dir, "--json"], h.deps)).toBe(0);
    const ok = JSON.parse(h.out.join("\n"));
    expect(ok.ok).toBe(true);
    const byName = Object.fromEntries(ok.checks.map((c: any) => [c.name, c]));
    expect(byName["API keys"].detail).toContain("groq (env: GROQ_API_KEY)");
    expect(byName["API keys"].detail).not.toContain("g)");
    expect(byName.Ollama.level).toBe("ok");
    expect(byName["tollfree command"].level).toBe("warn"); // PATH is empty in this harness
    expect(byName.OpenCode.detail).toContain("1.2.3");

    writeFileSync(join(h.dir, "command/quota.md"), "edited\n");
    h.out.length = 0;
    await runDoctor(["--dir", h.dir, "--json"], h.deps);
    expect(
      JSON.parse(h.out.join("\n")).checks.find((c: any) => c.name === "Installation").level
    ).toBe("warn");

    (await import("node:fs")).rmSync(join(h.dir, "agent/tollfree.md"));
    h.out.length = 0;
    expect(await runDoctor(["--dir", h.dir], h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("1 missing");
  });

  test("an empty machine gets warnings with next steps, not a crash", async () => {
    const h = harness();
    expect(await runDoctor(["--dir", join(h.dir, "nope")], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("tollfree init");
    expect(text).toContain("none found");
  });
});
