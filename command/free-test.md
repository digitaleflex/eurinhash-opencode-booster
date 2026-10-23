---
description: Teste tous les modèles FREE, affiche un rapport trié par qualité/prix, et permet de changer le modèle par défaut. Utilise le script tollfree free-test pour le scan ou affiche le rapport cached.
agent: tollfree
---

Exécute la commande appropriée selon l'argument :

**Arguments supportés :**
- (aucun) → `tollfree free-test report` — affiche le rapport cached
- `test` → `tollfree free-test test` — lance le scan complet de tous les modèles FREE
- `list` → `tollfree free-test list` — liste les modèles sans tester
- `use <model>` → `tollfree free-test use <model>` — change le modèle par défaut

**Contexte :** $ARGUMENTS

Rends un tableau clair en français avec le statut, latence, qualité et coût EUR/INR de chaque modèle testé.
