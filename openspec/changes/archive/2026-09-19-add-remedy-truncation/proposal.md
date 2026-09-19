# Change add-remedy-truncation

## Pourquoi

L'analyse indépendante du premier passage réel du jeu naturel (19/09) désigne la **troncation d'affichage des longs messages** comme irritant n° 1 de sdig. Le corpus contient les textes intégraux, mais `sdig read` n'en rend qu'un extrait — et la sortie ne le dit pas. Conséquences mesurées sur 50 questions :

- **3 réponses sur 50 produisent des fausses affirmations d'absence** (« l'archive n'en conserve pas davantage », « non récupérable », « confirme le contenu ci-dessus ») — toutes fausses, les textes intégraux existent dans le corpus (extraits à l'appui dans l'analyse). Un agent — comme un humain — conclut que la source est limitée alors que c'est l'affichage.
- **~12 réponses perdent des items d'énumération** (prix, noms de benchmarks, règles, options) : la restitution des listes est la première victime de la reconstruction par extraits.
- Les autres questions luttent contre la troncation au prix de 20-39 appels d'outils (recherches ciblées, `sdig raw`, `--json`).

Le corpus n'est pas en cause ; le rendu oui. C'est le remède prioritaire R3+R1 de l'analyse (R2 — chronologie des mutations — est un change séparé, non couvert ici).

## Quoi change

- **MODIFIED** `Lecture du contexte et accès à la preuve` (spec `search`) : marqueur de troncation auto-suffisant — compteurs exacts (caractères affichés / total) et chemin documenté vers le texte intégral — sur toute coupure d'affichage d'un message ; options `--full` (limite levée) et `--chars N` (limite explicite) sur `sdig read` ; `--json` documenté comme non tronqué.
- Aucun changement de schéma de corpus, d'index, ni de sous-commande.

## Impact

- **Specs** : `search` (1 requirement).
- **Code** : rendu des messages (`src/read.js` + formatage) — limite par message, compteurs, marqueur ; `parseArgs` (2 nouvelles options — piège documenté : toute option non déclarée avale la suivante).
- **Validation** (harnais existant uniquement — le jeu naturel est gelé, jamais re-passé) : tests unitaires (marqueur, compteurs, `--full`, `--chars`, `--json`), requêtes dorées inchangées (`npm run eval`), et migration de deux questions **brûlées** par l'analyse vers `eval/queries.json` en régression (reformulées par mots-clés, jamais verbatim).
