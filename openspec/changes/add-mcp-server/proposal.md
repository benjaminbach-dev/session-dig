# Change add-mcp-server

## Pourquoi

`sdig` dispose déjà d'une recherche BM25, d'une lecture de session avec ancrage temporel et d'un accès aux preuves brutes. Le premier passage naturel a montré un bon rappel du couple agent + outil sur ce jeu, mais une restitution encore incomplète. Le MCP doit rendre ces fonctions accessibles directement aux agents, sans détour par le shell ; il ne prétend pas améliorer à lui seul la fidélité des réponses.

L'archive est privée et le dépôt public. La v1 conserve donc la lecture seule, le confinement loopback, les validations HTTP et des identifiants, les journaux sans contenu et `raw` désactivé par défaut. Ce que retourne le service peut néanmoins être transmis au fournisseur du modèle appelant.

## Quoi change

- **ADDED** — capacité `mcp` : transport Streamable HTTP local, catalogue fermé (`sdig_search`, `sdig_read`, `sdig_raw` optionnel, `sdig_status`), réponses bornées, ancrage identique au CLI, continuation adaptée à chaque outil, délais applicables, confidentialité et fraîcheur.
- **Rescopage v1 (20/09, demandé par l'utilisateur)** : recherche par extraits avec références vers `read` ; continuation de la liste des hits, mais pas de fragmentation du texte intégral dans `search`. La lecture complète par fragments appartient à `read` et, s'il est activé, à `raw`.
- Les compteurs retournés sont exacts quand connus ; un total indisponible est `null`, jamais estimé. Pas de calcul exhaustif exigé seulement pour compter les résultats.
- Un délai dépassé donne une erreur `timeout`, sans récupération de résultat partiel. Le travail est isolé et arrêté ; le créneau n'est réutilisé qu'après confirmation de l'arrêt. Pas de promesse d'arrêt instantané.
- Le déterminisme porte sur les données et leur ordre pour un appel terminé sur un corpus inchangé, pas sur les curseurs, identifiants de requête, durées ou erreurs liées à l'exécution.
- Aucun changement des capacités `corpus`, `search` et `natural-eval` : réutilisation de leurs fonctions et de leur sémantique. Aucun code dans ce change ; implémentation séparée, sur accord explicite.

## Impact

- **Specs seulement** : `proposal.md`, `design.md`, `tasks.md` et delta `specs/mcp/spec.md`.
- **Code futur** : façade MCP sur les fonctions existantes, adaptation partagée de la recherche pour paginer les hits sans dupliquer le scoring, mécanisme de continuation et isolation du travail. SDK officiel à vérifier et épingler au début du change d'implémentation, pas ici.
- **Supervision** : l'ajout au manifeste Termux reste une décision propriétaire distincte ; aucune modification de service ni installation dans ce change.
- **Hors périmètre** : ingestion/indexation, shell, accès fichier arbitraire, exposition externe, multi-utilisateur, embeddings, synthèse automatique, remplacement du CLI, totaux exhaustifs obligatoires, résultats partiels après timeout et pagination intégrale du texte dans la recherche.
- **Protection du jeu d'évaluation** : aucun outil de lecture de fichier, aucune ingestion de ses fichiers par le service. Cela ne promet pas de retirer d'anciens extraits qui seraient déjà présents dans l'archive.
