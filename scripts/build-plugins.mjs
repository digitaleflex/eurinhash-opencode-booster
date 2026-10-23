// Bundles each OpenCode plugin (plugin/*.ts) with its src/core imports into one self-contained
// ES module in dist/plugin/. `tollfree init` installs these, so a user needs nothing else from this repo.
// Each entry is a shim that re-exports only the default plugin function: OpenCode treats every
// exported function of a plugin module as a plugin, and audit-logger.ts also exports helpers.
import { build } from "esbuild";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist", "plugin");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const plugins = readdirSync(join(root, "plugin")).filter((f) => f.endsWith(".ts"));
for (const file of plugins) {
  const name = file.replace(/\.ts$/, "");
  await build({
    stdin: {
      contents: `export { default } from ${JSON.stringify(pathToFileURL(join(root, "plugin", file)).href.replace("file://", ""))};`,
      resolveDir: root,
      sourcefile: `${name}.entry.ts`,
      loader: "ts",
    },
    outfile: join(out, `${name}.js`),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    legalComments: "none",
    logLevel: "warning",
  });
}
writeFileSync(join(out, ".built"), plugins.join("\n") + "\n");
console.log(`bundled ${plugins.length} plugins -> dist/plugin`);
