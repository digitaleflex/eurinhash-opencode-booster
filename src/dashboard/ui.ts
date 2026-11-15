// src/dashboard/ui.ts — Single-page UI served by the dashboard. No external assets (CSP: self only).
// The API token travels in the URL fragment (#token): it never reaches the server logs or Referer.

export function renderPage(version: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tollfree Command Center</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e8ee;--dim:#8b93a7;--ok:#3ecf8e;--warn:#f5b84b;--bad:#f0616d;--acc:#6ea8ff}
@media (prefers-color-scheme:light){:root{--bg:#f4f5f8;--panel:#fff;--line:#dfe2ea;--fg:#1a1d26;--dim:#5d6578}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:12px;align-items:baseline;padding:14px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0}header span{color:var(--dim)}
main{display:grid;gap:12px;padding:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:0 0 8px}
ul{list-style:none;margin:0;padding:0}li{padding:3px 0;display:flex;gap:8px;justify-content:space-between}
code,pre{font:12px ui-monospace,monospace}pre{white-space:pre-wrap;margin:6px 0 0;max-height:220px;overflow:auto}
input{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer;margin-top:6px}
button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.dim{color:var(--dim)}
#err{color:var(--bad);padding:8px 16px}
</style>
</head>
<body>
<header><h1>Tollfree Command Center</h1><span>v${version}</span><span id="proj" class="dim"></span></header>
<div id="err" role="alert"></div>
<main>
<section aria-labelledby="h-chat"><h2 id="h-chat">Chat · gouvernance</h2>
<form id="chat"><label class="dim" for="chat-in">Tâche à soumettre</label><input id="chat-in" autocomplete="off" required><button>Envoyer</button></form><pre id="chat-out"></pre></section>
<section aria-labelledby="h-git"><h2 id="h-git">Git</h2><div id="git">…</div>
<form id="commit"><label class="dim" for="commit-in">Message de commit</label><input id="commit-in" autocomplete="off" required><button>Commit</button></form><pre id="commit-out"></pre></section>
<section aria-labelledby="h-tree"><h2 id="h-tree">Fichiers</h2><ul id="tree"></ul></section>
<section aria-labelledby="h-term"><h2 id="h-term">Terminal (protégé)</h2>
<form id="term"><label class="dim" for="term-in">Commande</label><input id="term-in" autocomplete="off" required><button>Exécuter</button></form><pre id="term-out"></pre></section>
<section aria-labelledby="h-wk"><h2 id="h-wk">Workers</h2><ul id="workers"></ul></section>
<section aria-labelledby="h-sys"><h2 id="h-sys">Système</h2><ul id="system"></ul></section>
</main>
<script>
const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const li = (a, b, cls) => { const e = document.createElement("li"); const x = document.createElement("span"); x.textContent = a; const y = document.createElement("span"); y.textContent = b; if (cls) y.className = cls; e.append(x, y); return e; };
async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "x-tollfree-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.blocked) throw new Error(j.error || r.statusText);
  return j;
}
const show = (id, v) => { $(id).textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2); };
const fail = (e) => { $("err").textContent = e.message; };
async function refresh() {
  try {
    $("err").textContent = "";
    const s = await api("/api/system"); $("proj").textContent = s.project;
    const sys = $("system"); sys.replaceChildren(li("plateforme", s.platform + " · node " + s.node), li("uptime", s.uptimeSec + " s"), li("charge 1 min", s.load1.toFixed(2) + " / " + s.cpuCount + " cpu"), li("mémoire", s.memUsedMb + " / " + s.memTotalMb + " Mo"), li("exécution workers", s.executeEnabled ? "activée" : "verdict seul", s.executeEnabled ? "warn" : "dim"));
    const w = await api("/api/workers"); const wl = $("workers");
    wl.replaceChildren(li("mode", w.mode), ...(w.workers.length ? w.workers.map((x) => li(x.id, x.state + (x.latencyMs != null ? " · " + x.latencyMs + " ms" : ""), x.state === "ok" ? "ok" : x.state === "rate_limited" ? "warn" : "bad")) : [li("aucun état", "lancer: tollfree probe", "dim")]));
    const g = await api("/api/git");
    $("git").replaceChildren(...(g.repo ? [li("branche", g.branch), ...g.files.map((f) => li(f.path, f.status, "warn"))] : [li("pas un dépôt git", "", "dim")]));
    const t = await api("/api/tree?path=.");
    $("tree").replaceChildren(...t.entries.map((e) => li(e.name + (e.dir ? "/" : ""), "", e.dir ? "dim" : "")));
  } catch (e) { fail(e); }
}
function wire(formId, inId, outId, path, field, render) {
  $(formId).addEventListener("submit", async (ev) => {
    ev.preventDefault(); const v = $(inId).value;
    try { const r = await api(path, { [field]: v }); show(outId, render ? render(r) : r); $(inId).value = ""; refresh(); }
    catch (e) { show(outId, e.message); }
  });
}
wire("chat", "chat-in", "chat-out", "/api/chat", "message");
wire("commit", "commit-in", "commit-out", "/api/git/commit", "message", (r) => r.output);
wire("term", "term-in", "term-out", "/api/terminal", "command", (r) => r.blocked ? "BLOQUÉ : " + r.reason : (r.stdout + r.stderr + "\\n[exit " + r.exitCode + "]"));
refresh(); setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
