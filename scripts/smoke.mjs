// End-to-end check of the compiled CLI on plain Node, in a throwaway config dir:
// init -> init again (no change) -> doctor -> update -> uninstall (leaves nothing behind).
// Used by CI on Linux, macOS and Windows; run locally with `npm run smoke` after `npm run build`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "index.js");
const dir = mkdtempSync(join(tmpdir(), "tollfree-smoke-"));
const env = { ...process.env, NO_COLOR: "1", TOLLFREE_DIR: dir };
for (const k of [
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "ZHIPU_API_KEY",
  "OPENROUTER_API_KEY",
  "NOVITA_API_KEY",
])
  delete env[k];

let failed = 0;
function step(name, args, check) {
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 60_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const problem = check(r.status, out);
  console.log(`${problem ? "FAIL" : "ok  "} ${name}${problem ? ` -> ${problem}\n${out}` : ""}`);
  if (problem) failed++;
}

step("--help", ["--help"], (s, o) =>
  s !== 0 || !o.includes("Setup:") ? "unexpected help output" : ""
);
step("init", ["init", "--dir", dir], (s, o) =>
  s !== 0 || !/\d+ new/.test(o) || !existsSync(join(dir, "agent", "tollfree.md"))
    ? "agents not installed"
    : ""
);
step("init again", ["init", "--dir", dir], (s, o) =>
  !/0 new, 0 updated/.test(o) ? "second init changed files" : ""
);
step("doctor", ["doctor", "--dir", dir, "--json"], (s, o) =>
  s !== 0 || !o.includes('"ok": true') ? "doctor reports a failure" : ""
);
step("update", ["update", "--dir", dir], (s, o) =>
  s !== 0 || !/0 new, 0 updated/.test(o) ? "update changed files" : ""
);
step("route", ["route", "code"], (s, o) =>
  s !== 0 || !o.startsWith("worker-") ? "route gave no worker" : ""
);
step("uninstall", ["uninstall", "--dir", dir], (s) => (s !== 0 ? "uninstall failed" : ""));
const left = readdirSync(dir).filter(
  (f) => !["free-models.json", "models-dev-cache.json"].includes(f)
);
if (left.length) {
  console.log(`FAIL uninstall left files behind: ${left.join(", ")}`);
  failed++;
}
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nsmoke test passed");
process.exit(failed ? 1 : 0);
