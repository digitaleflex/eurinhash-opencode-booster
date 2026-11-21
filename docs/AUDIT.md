# Audit de complétude — Tollfree

État vérifié par exécution (2026-11-15). Chaque ligne est reproductible avec `bun run verify`.

| Domaine | État | Preuve |
|---|---|---|
| Types, format, build | OK | `tsc --noEmit`, `prettier --check`, `npm run build` |
| Tests unitaires | OK | vitest (169) + `bun test src/core/core.test.ts` (140) |
| Fuzz, corpus d'attaques, chaos | OK | `test:fuzz`, `test:golden` (39 cas), `chaos` |
| E2E CLI | OK | `bun run smoke` : init, doctor, update, route, uninstall |
| CLI | Complet | init, update, uninstall, doctor, route, probe, quota, direct/run, free-test, models-free, audit-log, **dashboard** |
| Gouvernance | Complet | politique, garde destructive, injection, secrets, confinement, budget, preuves Merkle, circuit breaker |
| Dashboard | Complet | `src/dashboard/` + `dashboard.test.ts` (sécurité et API sur un vrai serveur) |
| Couverture | Seuils en CI | statements 68 %, lignes 70 %, fonctions 70 %, branches 57 % (`vitest.config.mts`) |

## Limites connues

- La couverture Vitest ne compte pas `src/core/core.test.ts` (exécuté sous Bun) : le chiffre réel est plus haut.
- `free-models.json` et `daily_budget.json` sont de l'état local ignoré par git ; ils se régénèrent avec `tollfree probe`.
- Le dashboard n'exécute rien sur un worker sans `--execute` (choix de sécurité : pas d'effet réseau implicite).
- Les issues Command Center #51 à #80 décrivent un produit plus large (UI terminal, orchestration multi-agents) : elles restent hors de ce périmètre.
