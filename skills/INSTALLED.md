# Installed third-party skills — provenance & security review

> Every third-party skill below was scanned with the TOLLFREE
> `InjectionDetector` before installation. Findings are listed; benign
> documentation examples (`${...}` in shell/JS snippets) were reviewed by a
> human and accepted. Re-scan after any update:
> `bun run scripts/scan-skills.ts` (or re-run the detector manually).

| Skill | Source | Commit | Installed | Scan |
|---|---|---|---|---|
| systematic-debugging | obra/superpowers | b36e082 (2026-08-12) | 2026-09-10 | 2 benign flags reviewed+accepted (`${IDENTITY…}`, `` `${description}` `` in docs) |
| verification-before-completion | obra/superpowers | b36e082 (2026-08-12) | 2026-09-10 | clean |
| test-driven-development | obra/superpowers | b36e082 (2026-08-12) | 2026-09-10 | clean |
| requesting-code-review | obra/superpowers | b36e082 (2026-08-12) | 2026-09-10 | clean |
| executing-plans | obra/superpowers | b36e082 (2026-08-12) | 2026-09-10 | clean |
| finishing-a-development-branch | obra/superpowers | b36e082 (2026-08-12) | 2026-09-10 | clean |
| code-review | mattpocock/skills | 3cca18b (2026-09-04) | 2026-09-10 | clean |
| diagnosing-bugs | mattpocock/skills | 3cca18b (2026-09-04) | 2026-09-10 | clean |
| resolving-merge-conflicts | mattpocock/skills | 3cca18b (2026-09-04) | 2026-09-10 | clean |
| git-guardrails-claude-code | mattpocock/skills | 3cca18b (2026-09-04) | 2026-09-10 | clean |
| setup-pre-commit | mattpocock/skills | 3cca18b (2026-09-04) | 2026-09-10 | clean |

Update procedure: re-clone the source, copy only the listed directory,
re-scan, bump the commit SHA + date above.
