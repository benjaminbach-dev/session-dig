# Change add-mcp-server

> **Recentrage effectué à la demande explicite de l'utilisateur.** Cadrage : outil léger fait par et pour un développeur solo, avec pour prochaine étape un usage solo local validé sur PC (jalon commun défini dans la proposition de `scale-corpus`). Conséquences : la première livraison MCP se limite à **`sdig_search`, `sdig_read` et `sdig_status`** ; `sdig_raw`, la pagination de recherche, le parallélisme et le timeout strict sont des extensions conditionnelles, à décider selon l'usage et sur nouvel accord. La confidentialité et les descriptions des outils restent obligatoires dès le MVP.

## Pourquoi

`sdig` dispose déjà d'une recherche BM25, d'une lecture de session avec ancrage temporel et d'un accès aux preuves brutes. Le MVP MCP rend la recherche et la lecture de messages accessibles aux agents, sans détour par le shell ; les preuves brutes restent accessibles par le CLI en attendant une éventuelle extension. Il ne prétend pas améliorer à lui seul la fidélité des réponses.

L'archive est privée et le dépôt public. La v1 conserve donc la lecture seule, le confinement loopback, les validations HTTP et des identifiants, les journaux sans contenu — et un catalogue qui n'inclut pas `sdig_raw` (reporté, voir « Quoi change »). Ce que retourne le service peut néanmoins être transmis au fournisseur du modèle appelant.

## Quoi change

- **ADDED** — capacité `mcp` : transport Streamable HTTP local, catalogue fermé **`sdig_search`, `sdig_read`, `sdig_status`** (sans `sdig_raw` en v1 — ajout éventuel soumis à un nouvel accord), réponses bornées, ancrage identique au CLI, recherche top-k sans curseur, continuation de read garantissant le texte complet de la vue choisie, confidentialité et fraîcheur par source. Les notes de sécurité écrites pour le raw antérieur (exposition de secrets, `unvetted`, données non fiables) restent documentées pour la phase future, sans devenir des tâches bloquantes du MVP.
- **ADDED (fidélité pi)** — reprise du signal de limites de l'adaptateur pi dans search/read, continuations et lecture vide à l'ancre comprises : branches aplaties et éditions non appliquées, métadonnées structurées associées à pi et incluses dans le budget ; aucune reconstruction sémantique.
- **ADDED (compteurs)** — le total des hits est exact quand connu ; un total indisponible est `null`, jamais estimé. Pas de calcul exhaustif exigé seulement pour compter les résultats.
- **ADDED (concurrence honnête)** — le service est **mono-travail** : un seul appel de lecture actif ; à l'admission, un créneau occupé donne `busy`, sans file applicative supplémentaire. Un appel reçu pendant un calcul synchrone peut n'être traité qu'après sa fin : ni refus immédiat ni délai garanti. Aucune promesse d'annulation. Les limites de taille bornent le volume des réponses, pas la durée du calcul. Le timeout applicatif strict avec arrêt observable (D9 antérieur) est **hors MVP**, à réexaminer si l'usage le nécessite.

## Impact

- **Specs seulement** : `proposal.md`, `design.md`, `tasks.md` et delta `specs/mcp/spec.md`.
- **Code futur** : façade MCP sur les fonctions existantes, ordre stable partagé pour le top-k sans dupliquer le scoring, accès borné aux messages et continuation de read sans matérialiser une session entière. SDK officiel à vérifier et épingler au début du change d'implémentation, pas ici.
- **Supervision** : l'ajout au manifeste Termux reste une décision propriétaire distincte ; aucune modification de service ni installation dans ce change.
- **Hors périmètre** : `sdig_raw` MCP, scan de preuves brutes, pagination des hits, concurrence >1 et timeout applicatif garanti, ingestion/indexation, shell, accès fichier arbitraire, exposition externe, multi-utilisateur, embeddings, synthèse automatique, remplacement du CLI, totaux exhaustifs obligatoires, résultats partiels issus d'un calcul interrompu, pagination intégrale du texte dans la recherche.
- **Protection du jeu d'évaluation** : aucun outil de lecture de fichier, aucune ingestion de ses fichiers par le service. Cela ne promet pas de retirer d'anciens extraits qui seraient déjà présents dans l'archive.
