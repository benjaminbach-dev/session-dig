# Tâches — add-remedy-truncation

- [x] 1. Rendu : compteurs de troncation exacts + marqueur auto-suffisant sur `sdig read` (messages, `--around`, `--ctx`, `--tail`) et sur les hits de recherche groupés — jamais de coupure silencieuse.
- [x] 2. Options `--full` et `--chars N` sur `read` (déclarées dans parseArgs — piège : une option non déclarée avale la suivante) ; documenter `--json` comme non tronqué dans l'aide.
- [x] 3. Tests : message long → marqueur + compteurs exacts ; `--full` → intégral, aucun marqueur ; `--chars N` → borne appliquée ; message court → aucun marqueur ; `--json` → texte intégral. (32 → 40 : +8 dans `test/truncation.test.js`.)
- [x] 4. `npm run eval` : 26/26 inchangé — aucune retouche de scoring, le remède est purement affichage (script `eval` ajouté à package.json au passage).
- [x] 5. Migrer les deux questions brûlées vers `eval/queries.json` (reformulées par mots-clés, expect = session source, note de provenance) : contenu « règles figées + découpage en capacités » (session console du 12/08) et « P0 impersonate + remote token » (session specs MCP du 26/08).
- [x] 6. Vérifié sur le corpus réel : `--full` restitue les dix règles et six capacités (n43) et les listes P0/P1/impersonate (n41) ; le marqueur sur hit de recherche donne les compteurs exacts et un chemin qui fonctionne (vérifié : `sdig read … --full` et `sdig search --json` champ `text` intégral).
- [x] 7. `openspec validate` strict sur le change, puis archiver (`openspec archive add-remedy-truncation`).
