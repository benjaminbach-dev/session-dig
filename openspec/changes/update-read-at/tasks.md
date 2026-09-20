# Tâches — update-read-at

- [ ] 1. `src/read.js` — `resolveAnchor` : validation calendaire stricte (mois 1–12, jour réel du mois avec bissextiles, heure 0–23, minute/seconde 0–59) avant toute construction de date ; résolution en **UTC** (`Date.UTC`) ; messages d'erreur nommant l'ancre et le motif ; ancre vide/espaces → erreur « ancre vide ».
- [ ] 2. `src/read.js` — `sessionSlice` : une ancre **fournie** (`''` inclus) n'est plus ignorée ; seul `undefined`/`null` signifie « pas d'ancrage ». Une ancre vide devient donc fatale (exit non nul), plus une session entière silencieuse.
- [ ] 3. `bin/sdig.js` + `README.md` : aide alignée — horodatages **UTC** (comme l'affichage), refus explicites (date inexistante, heure hors bornes, ancre vide), date seule = fin de journée UTC.
- [ ] 4. Tests de régression (`test/read.test.js`) : `2026-02-30`, `2026-13-01`, `2026-09-00`, `2026-09-05T25:00`, `2026-09-05T10:75`, `2026-09-05T10:30:61` → erreurs fatales nommant l'ancre ; `2026-02-29` (bissextile) acceptée ; ancre vide en bibliothèque (`''`, `'  '`) → fatale ; CLI `--at ""` → exit non nul.
- [ ] 5. Tests d'indépendance du fuseau : CLI relancé en sous-processus sous `TZ=UTC`, `TZ=Europe/Paris`, `TZ=America/New_York` avec la même ancre horodatée → ancre résolue et vue identiques ; et un repère inverse (le même horodatage local ne doit PAS être interprété différemment selon le fuseau).
- [ ] 6. `npm test` (suite complète), `npm run eval` (28/28 attendu — la recherche n'est pas touchée), `openspec validate --specs --changes --strict`, puis archiver (`openspec archive update-read-at -y`).
