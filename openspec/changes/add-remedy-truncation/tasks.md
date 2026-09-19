# Tâches — add-remedy-truncation

- [ ] 1. Rendu : compteurs de troncation exacts + marqueur auto-suffisant sur `sdig read` (messages, `--around`, `--ctx`, `--tail`) et sur les hits de recherche groupés — jamais de coupure silencieuse.
- [ ] 2. Options `--full` et `--chars N` sur `read` (déclarées dans parseArgs — piège : une option non déclarée avale la suivante) ; documenter `--json` comme non tronqué dans l'aide.
- [ ] 3. Tests : message long → marqueur + compteurs exacts ; `--full` → intégral, aucun marqueur ; `--chars N` → borne appliquée ; message court → aucun marqueur ; `--json` → texte intégral. (32 → 32+N.)
- [ ] 4. `npm run eval` : 26/26 inchangé — aucune retouche de scoring, le remède est purement affichage.
- [ ] 5. Migrer les deux questions brûlées vers `eval/queries.json` (reformulées par mots-clés, expect = session source, note de provenance) : contenu « règles figées + découpage en capacités » (session console du 12/08) et « P0 impersonate + remote token » (session specs MCP du 26/08).
- [ ] 6. Vérifier que le contenu visé par les questions brûlées est atteignable par le chemin documenté dans le marqueur (`--full` ou `search --json`).
- [ ] 7. `openspec validate` strict sur le change, puis archiver (`openspec archive add-remedy-truncation`).
