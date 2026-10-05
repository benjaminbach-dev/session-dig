# Change add-mcp-chrono

## Pourquoi

Les outils MCP (`sdig_search`, `sdig_read`, `sdig_status`, change `add-mcp-server`) exposent aujourd'hui la recherche en **top-k de pertinence BM25** : `sdig_search` exige une requête plein texte (`invalid_params` sans terme exploitable), classe par pertinence et ne trie ni ne parcourt la chronologie. Le tri chronologique existe pourtant dans le **CLI** (`--sort relevance|oldest|newest`, exploration sans mots-clés), cadré par le change `add-cli-chronological-sort` et implémenté localement ; il n'est **pas** exposé par le MCP.

Le **banc d'usage hermétique du 05/10/2026** (`eval/hermetic/results-2026-10-05.md`) a fait travailler un agent sous cloche, ne disposant que des trois outils MCP. Résultat : **8/10** questions naturelles réussies, mais l'échec **Q2** (« première utilisation du modèle GLM 5.3 ») est **structurel**, pas de raisonnement. Sans tri chronologique ni exploration sans mots-clés, l'agent doit deviner des mots puis espérer que le top-k de pertinence remonte le plus ancien message : il a raté la première utilisation de **8 jours** (2026-08-18 confondu avec 2026-08-26). En usage réel, ce mur a déjà poussé un agent à **contourner le MCP pour interroger la base en SQL** — exactement le détour que la façade MCP devait supprimer.

Ce change est **documentaire** : il fige le cadrage minimal d'un tri chronologique MCP, sans implémenter quoi que ce soit.

## Quoi change

- **MODIFIED** — exigence `mcp` « Catalogue d'outils et fermeture » : `sdig_search` accepte `sort` à valeurs **fermées** `relevance` (défaut) | `oldest` | `newest` ; **option omise = contrat BM25 strictement inchangé** ; en `oldest`/`newest`, `query` MAY être **omise** (mode exploration), en `relevance` elle SHALL rester obligatoire ; une requête fournie vide / en espaces / sans terme exploitable SHALL être refusée (`invalid_params`) et ne SHALL jamais basculer silencieusement en exploration ; la recherche reste **top-k bornée sans curseur quel que soit `sort`** ; l'ordre chronologique est `(ts, id COLLATE BINARY)` sur l'ensemble des matches filtrés avant `limit` ; toute valeur de `sort` inconnue SHALL être refusée.
- **ADDED** — « Tri chronologique de la recherche MCP » : sélection globale puis ordre `(ts, id BINARY)`, réutilisation de la normalisation de requête et des filtres existants (`repo`, `session`, `source`, `after`/`before`, `model`, `role`, `agent`), `limit` appliqué après l'ordre, score BM25 conservé en diagnostic **avec** requête.
- **ADDED** — « Exploration MCP sans mots-clés » : sous-ensemble canonique `role ∈ {user, assistant}` ∩ filtre `role` (une valeur `title`/inconnue → zéro hit, jamais de ligne de titre), événements à texte vide ou commandes seules inclus, `source` sur la **provenance archivée**, `model: null` explicite jamais inventé, `score: null` (BM25 non calculé).
- **ADDED** — « Honnêteté et bornes du tri chronologique MCP » : top-k borné, aucun curseur/pagination, `total` exact si `count < limit` sinon `null`, enveloppe 524 288 octets, extraits référencés vers `sdig_read`, fidélité pi conservée, `hits` porteur de l'ordre global (le regroupement par session n'est qu'un index), aucune réparation/réindexation implicite.

## Position vis-à-vis des changes actifs

- **`add-mcp-server` (OUVERT)** : ce change **MODIFIE** la capacité `mcp` en conséquence. La spec delta `MODIFIED` reprend **le texte complet** de l'exigence « Catalogue d'outils et fermeture » du delta d'`add-mcp-server`, pour ne rien perdre lors de l'archivage. **Règle d'ordre d'archivage, sans ambiguïté : `add-mcp-server` d'abord, PUIS ce change.** Si l'ordre inverse était retenu, le `MODIFIED` n'aurait aucune exigence de base à modifier et devrait être rebasé.
- **`add-cli-chronological-sort` (OUVERT)** : ce change **réutilise la sémantique CLI** du tri chronologique (même ordre `(ts, id BINARY)`, mêmes filtres, même distinction entre requête omise et requête fournie vide), sans en dépendre à l'archivage : la logique de sélection existe déjà côté moteur (`searchChrono`/`browseChrono` dans `src/retriever/bm25.js`). Aucune dépendance documentaire : ce change ne modifie pas la spec `search`, et l'archivage de `add-cli-chronological-sort` n'est pas un prérequis.
- **`scale-corpus` (OUVERT)** : non touché. Le tri chronologique MCP est une **lecture de la vue**, pas une modification de l'interface Retriever ni de son contrat de performance.

## Impact

- **Specs seulement** : `proposal.md`, `design.md`, `tasks.md` et delta `specs/mcp/spec.md` (un `MODIFIED`, trois `ADDED`). Aucune modification de `openspec/specs/` ni du delta `add-mcp-server`.
- **Code (futur, non implémenté ici)** : `src/mcp/schemas.js` (paramètre `sort`, `query` optionnelle, `score` nullable), `src/mcp/validate.js` (règle croisée `query`/`sort`), `src/mcp/search.js` (aiguillage `search`/`searchChrono`/`browseChrono`, extraits bornés sans `snippet()` en exploration), description de `sdig_search`. **Aucune ligne de code n'est écrite par ce change documentaire.**
- **Non-régression** : mode `relevance` (défaut) strictement inchangé, aucun nouveau filtre, aucun changement du CLI, de `sdig_read`, de `sdig_status`, ni du curseur de lecture. Les tests MCP existants ne bougent pas tant que l'implémentation n'est pas commandée.
- **Hors périmètre** : curseur/pagination de recherche (extension déjà listée hors jalon), outil MCP de preuves brutes (`sdig_raw`), sous-commande nouvelle, embeddings/RRF, modification du scoring BM25, changement du CLI.
- **Confidentialité** : inchangée (archive locale, lecture seule, aucun egress). L'exploration élargit la **sélection** aux messages sans mot-clé mais ne change ni le budget de réponse, ni les journaux, ni l'absence d'authentification des clients locaux.

> **État au 05/10/2026** : cadrage documentaire seulement. `add-mcp-server` doit être archivé AVANT ce change ; ni ce change ni `add-mcp-server` ne sont archivés. Le jalon PC et la validation locale de `add-mcp-server` restent ouverts.
