// src/cli/quota.ts — Readable dashboard: today's spend, live worker state, advice (port of scripts/quota.py).
// Read-only and free: it never probes.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDir, dataDir } from "../core/paths";
import { Color, bold, dim, green, paint, readJson, readKey, red, yellow } from "./common";

const WORKERS: Array<[id: string, label: string, role: string]> = [
  ["worker-codestral", "Codestral", "le meilleur pour le code"],
  ["worker-groq", "Groq", "le plus rapide"],
  ["worker-novita", "Novita", "100% gratuit"],
  ["worker-zhipu", "Zhipu", "le plus polyvalent"],
  ["worker-google", "Google", "le plus costaud"],
  ["worker-ollama", "Ollama", "local, sans quota"],
  ["worker-pollinations", "Pollinations", "secours sans cle"],
];

const STATE_FR: Record<string, [text: string, color: Color]> = {
  ok: ["disponible", "green"],
  rate_limited: ["en pause (quota atteint)", "yellow"],
  error: ["en panne", "red"],
  unknown: ["jamais teste", "yellow"],
  skipped: ["ignore", "dim"],
};
const DOT: Record<string, string> = { green: "[OK]", yellow: "[!]", red: "[KO]", dim: "[..]" };

interface ModeState {
  mode: "free" | "pro";
  proMonthlyCapUsd?: number;
}

export function readMode(dir: string, env: NodeJS.ProcessEnv = process.env): ModeState {
  const fromEnv = (env.TOLLFREE_MODE || env.EURINHASH_MODE || "").trim().toLowerCase();
  if (fromEnv === "free" || fromEnv === "pro") return { mode: fromEnv };
  const file = readJson<ModeState>(join(dir, "mode.json"));
  if (file && (file.mode === "free" || file.mode === "pro")) return file;
  return { mode: "free" };
}

interface PerModel {
  [key: string]: { n: number; cost: number };
}

/** Sums today's assistant message costs from OpenCode's SQLite database (needs node:sqlite, Node >= 22.13). */
async function spendToday(dbPath: string): Promise<PerModel> {
  const sqlite: any = await import("node:sqlite" as string);
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const rows = db
      .prepare("select data from message where time_updated >= ?")
      .all(midnight.getTime());
    const per: PerModel = {};
    for (const row of rows as Array<{ data: string }>) {
      let m: any;
      try {
        m = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (m?.role !== "assistant") continue;
      const k = `${m.providerID}/${m.modelID}`;
      const e = (per[k] ??= { n: 0, cost: 0 });
      e.n += 1;
      e.cost += m.cost || 0;
    }
    return per;
  } finally {
    db.close();
  }
}

export async function runQuota(
  dir = configDir(),
  out: (l: string) => void = console.log
): Promise<number> {
  const modeState = readMode(dir);
  const cap = modeState.proMonthlyCapUsd;
  if (modeState.mode === "pro") {
    const capTxt =
      typeof cap === "number" ? `, plafond ${cap.toFixed(2)} $` : ", sans plafond defini";
    out(bold("=== Mode actuel : ") + yellow(bold(`PRO (payant autorise${capTxt})`)));
  } else {
    out(bold("=== Mode actuel : ") + green(bold("FREE (gratuit uniquement)")));
  }

  out(bold("=== Mon argent aujourd'hui ==="));
  const dbPath = join(dataDir(), "opencode.db");
  let perModel: PerModel = {};
  if (!existsSync(dbPath)) {
    out(
      "  " + dim("compteur local introuvable - `opencode stats --days 1 --models` pour le detail")
    );
  } else {
    try {
      perModel = await spendToday(dbPath);
    } catch (e) {
      out(
        "  " +
          dim(
            `compteur local illisible (${String((e as Error).message).slice(0, 80)}) - utilise \`opencode stats --days 1 --models\``
          )
      );
    }
  }
  const total = Object.values(perModel).reduce((s, e) => s + e.cost, 0);
  if (total <= 0) {
    out("  " + green("0,00 $ depense - tout est passe par du gratuit") + " [OK]");
  } else {
    out(`  ${bold(`${total.toFixed(2)} $`)} depenses aujourd'hui`);
    if (modeState.mode === "pro" && typeof cap === "number" && cap > 0) {
      const pct = Math.min(100, (total / cap) * 100);
      const filled = Math.floor(pct / 10);
      const bar = "#".repeat(filled) + ".".repeat(10 - filled);
      const color = pct >= 90 ? red : pct >= 70 ? yellow : green;
      out(
        `  ${color(`plafond mensuel : ${bar} ${pct.toFixed(0)}% (${total.toFixed(2)} $ / ${cap.toFixed(2)} $)`)}`
      );
      if (pct >= 90) {
        out(
          "  " +
            red(
              "[STOP] Plafond presque atteint - repasse en FREE (`/mode free`) ou augmente le plafond"
            )
        );
      }
    }
    const top = Object.entries(perModel)
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, 5);
    for (const [k, e] of top) out(`    ${k} : ${e.n} appels, ${e.cost.toFixed(4)} $`);
  }

  out("");
  out(bold("=== Mes modeles gratuits (etat en direct) ==="));
  const fm = readJson<{ updated?: number; models?: Record<string, string> }>(
    join(dir, "free-models.json")
  );
  const states = fm?.models ?? {};
  let ageMin: number | undefined;
  if (fm) ageMin = Math.floor((Date.now() / 1000 - (fm.updated ?? 0)) / 60);
  else out("  " + yellow("pas d'etat enregistre - lance `tollfree probe`"));
  for (const [wid, label, role] of WORKERS) {
    const raw = states[wid] ?? "unknown";
    const base = String(raw).split(":")[0];
    const [fr, color] = STATE_FR[base] ?? ["etat inconnu", "yellow"];
    out(`  ${DOT[color]} ${paint(color, label.padEnd(22))} ${fr}  ${dim(`(${role})`)}`);
  }
  if (ageMin !== undefined) {
    out(
      ageMin > 30
        ? "  " + yellow(`⚠ etat vieux de ${ageMin} min - relance \`tollfree probe\``)
        : `  ${dim(`etat verifie il y a ${ageMin} min`)}`
    );
  }

  out("");
  out(bold("=== Mon conseil du moment ==="));
  const okList = WORKERS.filter(([id]) => String(states[id] ?? "").split(":")[0] === "ok");
  if (okList.length) {
    const [, label, role] = okList[0];
    out(`  >> ${green(`Utilise ${label} en ce moment`)} (${role}, disponible)`);
    const rest = okList.slice(1, 3).map(([, l]) => l);
    if (rest.length) out(`     Secours : ${rest.join(", ")}`);
  } else {
    const waiting = WORKERS.some(([id]) =>
      ["rate_limited", "unknown"].includes(String(states[id] ?? "").split(":")[0])
    );
    out(
      waiting
        ? "  " +
            yellow(
              "[..] Tous les gratuits sont en pause - attends un peu, ou passe en local (Ollama)"
            )
        : "  " + red("🔴 Tout est en panne - verifie tes cles API, puis relance `tollfree probe`")
    );
  }

  out("");
  out(bold("=== Cle OpenRouter (seule avec un compteur distant) ==="));
  try {
    const key = readKey(dir, ".openrouter-key");
    if (!key) throw new Error("pas de cle .openrouter-key");
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = ((await res.json()) as any).data ?? {};
    out(`  utilise : ${data.usage} / limite : ${data.limit}`);
    out(`  restant : ${data.limit_remaining}`);
  } catch (e) {
    out(`  ${dim("indisponible : " + String((e as Error).message).slice(0, 100))}`);
  }

  out("");
  out(dim("(autres providers = voir leur site, pas de compteur distant)"));
  return 0;
}
