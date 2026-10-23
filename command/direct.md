---
description: Contournement direct pour appeler les providers AI (Groq, Mistral, Google, etc.) avec fallback automatique comme TOLLFREE. Utilise les clés déjà configurées dans ~/.config/opencode/.
agent: tollfree
---

`tollfree direct $ARG`

**Exemples :**
- `/direct "explique la loi d'Ohm"` → utilise le fallback automatique (Groq → Mistral → ...)
- `/direct --model "codestral-latest" "que fait cette fonction ?"` → utilise un modèle spécifique
- `/direct --provider groq "salut"` → force un provider
- `/direct --list` → liste tous les modèles disponibles par provider
- `/direct --list-providers` → montre quels providers ont des clés configurées
- `/direct --json "test"` → sortie JSON brute (utile pour le traitement automatique)

**Notes :**
- Ce script est un contournement pour les cas où `opencode run` ne parvient pas à appeler les providers malgré des clés valides.
- Il implémente le même fallback automatique qu'TOLLFREE selon le type de tâche.
- Toutes les réponses sont tracées par le plugin audit-logger si actif (tool.execute.before/after).