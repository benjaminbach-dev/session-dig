# Tâches — update-natural-eval

- [x] 1. `scripts/audit-toolcalls.mjs` : scanne les toolCalls d'un dossier de run (un JSON par réponse), motifs épinglés (sqlite, opencode.db, index.db, events.jsonl, sessions.jsonl, chemin du répertoire corpus, `sdig ingest|refresh`), sortie markdown — une ligne par déviation : question, outil, extrait de commande, résumé final.
- [x] 2. Tests du script sur fixtures : une lecture directe de `events.jsonl` (listée), une ouverture sqlite (listée), un appel `sdig read`/`sdig raw` légitime (non listé — zéro faux positif).
- [x] 3. Exécuter l'audit sur les runs existants (`run-A`, `run-B`, `pilot-A`) et annexer le résultat au rapport du 19/09 (local, gitignored) — doit retrouver la lecture directe de run-A et les 2 sqlite du pilote.
- [x] 4. Documenter la grille de notation (✔/~/✖ par fait, buckets, tableau par question) dans `eval/natural/README.md` — formulation committable, sans contenu privé.
- [x] 5. Re-marquer le rapport du 19/09 avec le tableau par question (l'analyse indépendante fournit déjà la grille ; intégration locale).
- [x] 6. `openspec validate` strict sur le change, puis archiver (`openspec archive update-natural-eval`).
