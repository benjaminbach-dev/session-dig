# Design — scale-corpus

## D0 — Motivation et ordre des changes (20/09)

Contrainte utilisateur : le projet doit tourner ailleurs ; corpus 20-100× plus lourd au minimum, base source PC de 4 Go (contre ~4 Mo de corpus sur téléphone). Goulets vérifiés dans le code : `readJsonl` plein-fichier (utilisé par read/raw/search CLI/ingest), `ingest` à réécriture intégrale, `raw/` plat. La recherche tient déjà (SQL pur). Décision : passe échelle **avant** l'implémentation MCP — sinon la façade hérite des parcours complets et le contrat D9 du MCP (isolation du travail, timeout) enveloppe des lectures O(corpus).

Ce change est **documentaire**. Les nombres ci-dessous sont des bornes de conception, à vérifier et ajuster avec mesure (comme les cibles de performance de `search`) ; les principes (mémoire bornée, idempotence, archive de référence), eux, ne sont pas négociables.

## D1 — Layout v2 : shards par session

- `events/<p>/<sessionId>.jsonl`, `<p>` = deux premiers caractères de l'id de session ; une ligne par événement, ordre `(ts, id)` **dans** le shard, stable entre ingestions identiques.
- `sessions.jsonl` reste un flux unique (métadonnées, ordre `id`) : sa réécriture est le seul coût O(#sessions) d'une ingestion — borné et documenté (~Mo à l'échelle visée).
- `raw/<p>/<partId>.txt`, `<p>` = deux premiers caractères de l'id de part.
- `state.json` porte `layoutVersion: 2`. Tout outil refuse explicitement une autre version de layout (message nommant la version lue et attendue) — jamais d'interprétation implicite d'un layout inconnu.
- **Pourquoi des shards plutôt qu'un fichier unique + offsets** : append-only naturel, ingestion O(delta) sans réécriture globale, réparabilité par shard, pas d'index d'offsets à maintenir en cohérence avec les réécritures. Contre-coût assumé : beaucoup de petits fichiers, mitigé par le préfixe à deux caractères.
- Les **enregistrements** (schéma d'un événement, d'une session) sont strictement inchangés : `schemaVersion` des lignes reste 1 ; seule la découpe des fichiers et leur nommage changent, portés par `layoutVersion`.

## D2 — La vue dérivable devient le chemin de lecture

- L'index SQLite (aujourd'hui dédié à la recherche) s'étend en **vue de lecture** : table des événements avec le JSON intégral de chaque enregistrement + colonnes filtrables + FTS5, et table des sessions (métadonnées complètes).
- `read` (`--around`, `--ctx`, `--tail`, `--at`), les voisins de recherche et `status` s'y exécutent par **requêtes bornées** (fenêtres cléset sur `(sessionId, ts, id)`) : O(log n + k), mémoire bornée par la fenêtre.
- La logique métier (résolution d'ancre, masquage avant fenêtrage, marqueurs, troncature) est **conservée telle quelle** — seul l'accès aux données change. La sémantique CLI observable reste celle des specs `search` en vigueur.
- **Fraîcheur** : la vue porte le watermark du corpus auquel elle correspond ; toute lecture vérifie et **refuse explicitement** une vue absente ou périmée (avec l'instruction de réparation). `sdig read` devient dépendant de la vue — changement d'usage documenté dans le README.
- Le contrat « index jetable » est inchangé : entièrement reconstruisable depuis le seul corpus. En plus, la vue est **maintenue incrémentalement** pendant l'ingestion (insertions/suppressions ciblées) ; le rebuild complet reste la référence de réparation. En cas de divergence non résolue, le rebuild depuis le corpus fait foi.

## D3 — Ingestion O(delta)

- La source est lue en flux (watermark inchangé) : l'adaptateur produit ses résultats par lots bornés, sans matérialiser la base en mémoire.
- Seuls les shards des sessions **touchées** (nouvelles ou modifiées) sont réécrits — O(taille de session), jamais O(corpus). `sessions.jsonl` est réécrit (O(#sessions), borné).
- La vue dérivable est mise à jour **dans la même passe** (les événements insérés/modifiés/supprimés y sont appliqués), pas lors d'une réindexation séparée.
- **Verrou consultatif** (flock sur le corpus) contre deux ingestions concurrentes ; les lecteurs ne verrouillent pas (échanges atomiques par fichier, `rename`).
- **Défaillance** : écritures atomiques par fichier, `state.json` écrit en dernier. Un crash laisse des shards avancés et un watermark ancien → la passe suivante reconverge (idempotence). Jamais de corpus déchiré ni illisible.

## D4 — Mémoire bornée, partout

- Aucune commande (ingest, index, read, raw, search, `--raw`, status, migration) ne charge le corpus, la base source ou une archive v1 dans son intégralité en mémoire.
- Le `readJsonl` plein-fichier devient un usage **interdit sur les chemins de commande** ; le streaming (ligne à ligne, par lots) est la règle pour migration et rebuild.
- Cible de conception : empreinte < 512 Mo pour toute opération du banc à 500 000 événements (mesurée et consignée).

## D5 — Banc synthétique à l'échelle

- Extension du banc existant (`scripts/bench.mjs`) : générateur **déterministe** (graine épinglée) produisant un corpus synthétique réaliste — tailles de sessions inégales (dont des sessions monstres ~10 000 messages), messages longs, toolCalls, fichiers raw.
- Volumes : **100× le corpus réel actuel (~500 000 événements) par défaut**, 1000× en option. Mesures p50/p95 et empreinte mémoire consignées dans le dépôt.
- Le banc n'entre **pas** dans `npm test` (durée) : instrument de conception, pas porte de fusion.
- Cibles de conception (vérifiées au banc, ajustées avec justification sinon) : recherche p95 < 100 ms @ 500k événements ; première fenêtre de lecture p95 < 100 ms sur session de 10 000 messages ; delta d'ingestion ≤ 1 000 événements < 10 s sur corpus d'un million ; rebuild complet du banc < 5 min.

## D6 — Migration v1 → v2 sans source

- Une commande dédiée transforme un corpus v1 (flux uniques) en v2 : streaming ligne à ligne, jamais le corpus entier en RAM.
- Idempotente : relancer ne change rien. Vérifiée : comptes d'événements et de sessions conservés et annoncés ; les incohérences (ligne illisible, session sans événement) sont signalées, pas ignorées.
- Un corpus v1 face aux outils v2 → refus explicite avec la marche à suivre (migrer, ou re-ingérer depuis la source).

## D7 — Empreinte du corpus (conditions d'évaluation)

- `sdig status` (ou option dédiée) rend une **empreinte déterministe** : md5 par fichier, agrégés sur les chemins relatifs **triés** — indépendante de l'ordre du système de fichiers.
- Coût O(taille du corpus), commande explicite et documentée : elle remplace le « md5 du corpus » des conditions du jeu naturel (harnais d'examen, runs futurs) et n'est jamais calculée sur le chemin des commandes de lecture.

## D8 — Recherche brute `--raw`

- Reste opt-in et hors index (décision du 15/09 inchangée). Le scan passe en **flux** (fichier par fichier), mémoire bornée, durée affichée ; son coût O(raw/) est documenté — une opération consciente, pas une surprise.

## D9 — Interaction avec la v1 MCP

- La spec MCP ouverte (`add-mcp-server`) reste valable **sans modification** : plafonds par appel, continuation et fraîcheur sont déjà size-agnostiques.
- Le change d'implémentation MCP ajoutera la contrainte « workers jamais de chargement complet du corpus » — satisfaite de facto par D2/D4 puisque la façade réutilise les mêmes fonctions que le CLI.
- Le défaut de délai MCP (5 s) restera configurable ; la documentation du MCP précisera de le relever sur corpus volumineux.

## D10 — Hors périmètre

Embeddings (v2), sstats (v3), tout code MCP, changement du schéma des enregistrements, changement du scoring ou de la sémantique de recherche, distribution multi-machine, compression du corpus.
