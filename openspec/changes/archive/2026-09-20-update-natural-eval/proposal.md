# Change update-natural-eval

## Pourquoi

Le premier passage réel du jeu naturel (18-19/09, glm-5.3-flash) et son analyse indépendante (19/09, rapport local gitignored) ont confronté la spec au réel. Les fissures constatées se confirment, et l'analyse en révèle de nouvelles, dont deux touchent à la validité **déclarée** du run :

1. **La règle « accès via sdig » n'est ni codifiée ni auditée.** Le rapport annonce « 0 déviation » alors qu'une réponse a lu `events.jsonl` en direct (grep + python). Aucune contamination (corpus md5 intacts, clé hors corpus), mais la vérification reposait sur la seule attention de l'examinateur.
2. **La granularité de notation n'est pas définie.** « Fidélité pleine » vaut 36/50 (barre « faits clés », rapport final) ou 5/50 + 20 quasi-pleines (barre « chaque fait attendu », notes de correction) selon le seuil. La spec ne dit ni l'unité de notation, ni la définition des buckets, ni l'obligation de publier la grille par question (qui n'existe que pour 27/50).
3. **Les affirmations d'absence contredites par le corpus** (« l'archive n'en conserve pas davantage », « non récupérable », « confirme le contenu ci-dessus » — toutes fausses, textes intégraux extraits) ne sont pas tracées comme signal propre.
4. **L'ancrage temporel** (répondre l'état final plutôt que l'état au moment de la question) n'a été adjudiqué que par décision d'examinateur ; les conditions épinglées (md5, versions, prompt, graine) et le statut `recovered` ne sont exigés par la spec nulle part.
5. **Mono-notation** : l'examinateur a aussi construit l'outil ; n01 n'a jamais été noté et aucune relecture indépendante n'était prévue.

## Quoi change

- **MODIFIED** `Conditions d'exécution du test` : accès exclusif via sdig formalisé (interdiction de lecture directe des fichiers du corpus, d'`opencode.db`, d'`index.db`, sqlite) ; template de prompt d'examen épinglé (hash consigné) ; statut `recovered` défini avec sa preuve et son compteur.
- **ADDED** `Audit déterministe des accès` : script livré dans le dépôt, motifs épinglés, résultat annexé au rapport.
- **MODIFIED** `Notation en deux scores distincts` : unité = fait attendu (✔/~/✖), buckets sans ambiguïté, tableau par question obligatoire, fausses méta-affirmations tracées avec taux propre, adjudication temporelle (état à l'instant de la question), critère de rappel précisé (id tronqué accepté si l'id complet figure ailleurs).
- **MODIFIED** `Rapport d'exécution` : conditions épinglées obligatoires (md5 début/fin, versions, hash du prompt, graine d'ordre), tableau par question, compteurs recovered et fausses méta-affirmations, résultat d'audit.
- **ADDED** `Inter-notation indépendante` : second correcteur obligatoire au premier passage d'un jeu gelé, désaccords arbitrés contre le corpus, jamais de re-passage du jeu.

## Impact

- **Specs** : `natural-eval` uniquement (3 requirements modifiées, 2 ajoutées). Le jeu v1 reste gelé et n'est jamais re-passé.
- **Code** : un script d'audit (`scripts/audit-toolcalls.mjs`) et ses tests ; documentation de la grille dans `eval/natural/README.md` (contenu committable, sans données privées).
- **Non-goals** : ne change ni la composition du jeu, ni le protocole de passation, ni les specs `corpus`/`search` ; ne rend aucun audit rétroactif obligatoire pour les rapports passés (l'analyse du 19/09 a rejoué l'audit manuellement — le résultat est annexé localement).
