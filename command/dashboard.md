---
description: Lance le Command Center TOLLFREE (dashboard web) sur le projet courant. Ouvre http://localhost:4321.
agent: build
---

Lance le Command Center TOLLFREE sur le **projet courant** :

1. Détermine le répertoire du projet courant (le workspace actif d'opencode).
2. Lance le serveur en arrière-plan :
   ```bash
   tollfree dashboard "<répertoire du projet courant>"
   ```
   (ou `TOLLFREE_DASHBOARD_DIR="<répertoire>" tollfree dashboard`). Ajoute `--execute` seulement si l'utilisateur veut que les tâches approuvées soient réellement exécutées sur un worker gratuit (usage réseau/quota).
3. Recopie l'URL imprimée par la commande : **http://localhost:4321/#<jeton>**. Le jeton est aléatoire à chaque lancement et obligatoire pour l'API ; dis à l'utilisateur d'ouvrir cette URL complète dans son navigateur.
4. Rappelle ce que le Command Center permet :
   - **Chat** → envoie des tâches au GovernanceOrchestrator (classification, risk, policy, guard, proof en temps réel)
   - **Git** → branche réelle, fichiers modifiés, bouton commit fonctionnel
   - **File tree** → arborescence réelle du projet
   - **Terminal** → commandes réelles protégées par GuardOverrides (`rm -rf /` bloqué)
   - **Workers** → état live des workers gratuits (free-models.json + circuit breakers)
   - **System** → CPU, mémoire, uptime réels

Si le port 4321 est déjà occupé, propose `TOLLFREE_DASHBOARD_PORT=9999`.

Contexte : $ARGUMENTS