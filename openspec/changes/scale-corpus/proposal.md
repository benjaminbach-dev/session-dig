# Proposal — scale-corpus

## Pourquoi

Le projet doit tourner ailleurs que sur ce téléphone : l'utilisateur vise un corpus **20 à 100 fois plus lourd au minimum**, et la base source opencode de son PC fait **4 Go** (~1 000× les octets, ~100-300× les événements du corpus actuel). La vérification du code du 20/09 montre que la recherche tient déjà à cette échelle (SQL pur FTS5, `ORDER BY rank LIMIT`, jamais de parcours d'events.jsonl), mais que trois goulets cassent :

1. **`readJsonl`** : lecture `readFileSync` + parse du fichier entier — utilisé par `read`, `raw`, la recherche CLI (regroupement/contexte) et l'ingestion ; pointe mémoire ~4-5× la taille du fichier dès 1 Go de corpus.
2. **`ingest`** : corpus entier en Maps en RAM + **réécriture intégrale** des flux à chaque passe, même incrémentale — O(corpus total) en CPU, RAM et E/S.
3. **`raw/` plat** : 500k+ fichiers prévisibles à 100×.

Sans remède, la façade MCP planifiée envelopperait des parcours complets : ses workers passeraient leur temps à charger le corpus en mémoire. Ce change remet donc la couche d'accès à l'échelle **avant** l'implémentation MCP (ordre : v0.6 échelle → v1 MCP). Le principe « corpus = archive, index = vue jetable » est **renforcé**, pas abandonné : la vue reste entièrement reconstruisable depuis le seul corpus, et devient en plus le chemin de lecture borné.

## Quoi change

- **MODIFIED/RENAMED (corpus)** — `Schéma canonique v1` devient `Schéma canonique et layout v2` : les **enregistrements** (événement, session) sont inchangés ; seul le layout des fichiers change — shards par session `events/<p>/<sessionId>.jsonl` (ordre `(ts, id)` stable), `sessions.jsonl` unique pour les métadonnées, `raw/<p>/<partId>.txt` shardé, `layoutVersion` dans `state.json` avec refus explicite des autres versions.
- **MODIFIED (corpus)** — `Ingestion incrémentale et idempotence` : coût **O(delta)** — seuls les shards des sessions touchées sont réécrits, `sessions.jsonl` reste le seul coût O(#sessions), la vue dérivable est maintenue dans la même passe, verrou consultatif contre les ingestions concurrentes, écritures atomiques par fichier, convergence après interruption.
- **ADDED (corpus)** — `Vue dérivable en chemin de lecture` : l'index SQLite (jetable, reconstruisable) devient le chemin de lecture unique du CLI comme des façades futures — enregistrements complets, fenêtres bornées, refus explicite si vue absente ou périmée.
- **ADDED (corpus)** — `Opérations en mémoire bornée` : aucune commande ne charge le corpus, la source ou une archive v1 en entier ; parcours en flux partout ; cible mesurée au banc.
- **ADDED (corpus)** — `Migration du corpus v1` : passage v1→v2 **sans la source**, en flux, idempotent, vérifié.
- **ADDED (corpus)** — `Empreinte déterministe du corpus` : agrégat md5 sur chemins triés, remplaçant le md5 d'un fichier unique dans les conditions d'évaluation.
- **MODIFIED (search)** — `Interface Retriever` : l'indexation opère depuis le corpus **en flux**, jamais depuis un tableau matérialisé ; contrats inchangés.
- **MODIFIED (search)** — `Performance` : cibles re-visées à l'échelle (recherche p95 < 100 ms @ 500 000 événements) et **banc synthétique déterministe** commis et consigné, hors `npm test`.
- **MODIFIED (search)** — `Recherche brute optionnelle` : scan `--raw` en flux, coût O(raw/) documenté, mémoire bornée.

Aucun code dans ce change : spec d'abord (SDD), implémentation dans un change séparé, sur accord explicite.

## Impact

- **Specs** : `corpus` (1 renommée+modification, 2 modifications de wording, 4 ajouts) et `search` (3 modifications). Les capacités `natural-eval` et le change ouvert `add-mcp-server` ne changent pas — la spec MCP reste valable telle quelle.
- **Code (à venir, hors de ce change)** : adaptateur en flux, écriture par shards, ingest O(delta), vue SQLite étendue (JSON intégral + métadonnées de sessions), lecture read/around/ctx/tail/at par requêtes bornées, raw sharding, migration, empreinte, banc étendu. **Changement d'usage documenté** : `sdig read` devient dépendant de la vue dérivable (refus explicite si absente ou périmée, comme `search` aujourd'hui).
- **Évaluation** : `npm run eval` (28/28) doit rester vert — la sémantique de recherche ne change pas ; le harnais du jeu naturel épinglera l'intégrité du corpus par la nouvelle empreinte.
- **Hors périmètre** : embeddings (v2), sstats (v3), tout code MCP, changement du schéma des enregistrements, changement du scoring, multi-machine, compression du corpus.

## Ce que ce change protège

Interdire de répondre à une commande en chargeant l'archive entière ; interdire de réécrire le corpus entier pour un delta ; interdire de livrer une façade MCP dont les workers gonfleraient en RAM. Et préserver les acquis : idempotence octet par octet, ordre stable, source en lecture seule, archive locale jamais publiée, index entièrement reconstruisable.
