# Tâches — add-read-at

- [ ] 1. `src/read.js` : résolution de l'ancre (`msg_…` de la session, `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS]`, epoch ms) + fonction de troncature de vue (messages d'horodatage ≤ ancre, inclusion à l'instant exact). Échec explicite sur ancre inconnue, ancre d'une autre session, horodatage illisible.
- [ ] 2. `bin/sdig.js` : option `--at <ancre>` sur `read` (table `parseArgs` — piège documenté), erreur explicite sur option inconnue, aide du CLI mise à jour ; ordre des opérations fixé : masquage, puis `--around`/`--ctx`/`--tail` dans la vue.
- [ ] 3. `src/format.js` : marqueur de **masquage temporel** (compte masqué + rappel de l'ancre + « relire sans --at ») et en-tête d'ancre (`ancre : msg_… (date)`) ; marqueur de troncature inchangé et non confondu (scénario « Deux signaux distincts »).
- [ ] 4. `--json` : champs `anchor` (id + horodatage résolus) et `maskedCount` ; textes non tronqués ; `sdig raw` non filtré (scénario « La preuve reste entière »).
- [ ] 5. Fenêtre entièrement postérieure à l'ancre (`--around`/`--tail`) → message explicite rappelant l'ancre, jamais de vide ambigu ; code de sortie non nul sur ancre invalide.
- [ ] 6. Tests (`test/read.test.js`, fixture synthétique) : masquage, visibilité sans `--at`, inclusion de l'instant exact, fenêtre postérieure, ancre inconnue, ancre d'une autre session, horodatage illisible, `--json`, coexistence avec `--full`/`--chars`/marqueur de troncature.
- [ ] 7. Vérification locale (non committée) sur le corpus réel : session de n46 — ancre à 11:24 ⇒ `bash` encore visible ; lecture complète ⇒ retrait à 11:38 visible. Consigner le résultat dans le rapport local.
- [ ] 8. Documentation : README (section lecture), `openspec/implementation-plan.md` (R2 livré), note d'écart assumée vs `eval/queries.json` si le sujet revient.
- [ ] 9. `npm test` + `npm run eval` (28/28 inchangé — la recherche n'est pas touchée), `openspec validate --specs --changes --strict`, puis archiver (`openspec archive add-read-at`).
