---
description: Teste tous les modèles FREE, affiche un rapport trié par qualité/prix, et permet de changer le modèle par défaut. Utilise le script free-test.py pour le scan ou affiche le rapport cached.
agent: tollfree
---

Exécute la commande appropriée selon l'argument :

**Arguments supportés :**
- (aucun) → `python "${TOLLFREE_DIR:-$HOME/.config/opencode}/scripts/free-test.py" report` — affiche le rapport cached
- `test` → `python "${TOLLFREE_DIR:-$HOME/.config/opencode}/scripts/free-test.py" test` — lance le scan complet de tous les modèles FREE
- `list` → `python "${TOLLFREE_DIR:-$HOME/.config/opencode}/scripts/free-test.py" list` — liste les modèles sans tester
- `use <model>` → `python "${TOLLFREE_DIR:-$HOME/.config/opencode}/scripts/free-test.py" use <model>` — change le modèle par défaut

**Contexte :** $ARGUMENTS

Rends un tableau clair en français avec le statut, latence, qualité et coût EUR/INR de chaque modèle testé.
