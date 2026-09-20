# Proposal — scale-corpus

## Pourquoi

Le projet doit tourner ailleurs que sur ce téléphone : l'utilisateur vise un corpus **20 à 100 fois plus lourd au minimum**, et la base source opencode de son PC fait **4 Go** (~1 000× les octets, ~100-300× les événements du corpus actuel). La vérification du code du 20/09 montre que la recherche tient déjà à cette échelle (SQL pur FTS5, `ORDER BY rank LIMIT`, jamais de parcours d'events.jsonl), mais que trois goulets cassent :

1. **`readJsonl`** : lecture `readFileSync` + parse du fichier entier — utilisé par `read`, `raw`, la recherche CLI (regroupement/contexte) et l'ingestion ; pointe mémoire ~4-5× la taille du fichier dès 1 Go de corpus.
2. **`ingest`** : corpus entier en Maps en RAM + **réécriture intégrale** des flux à chaque passe, même incrémentale — O(corpus total) en CPU, RAM et E/S.
3. **`raw/` plat** : 500k+ fichiers prévisibles à 100×.

Sans remède, la façade MCP planifiée envelopperait des parcours complets : ses workers passeraient leur temps à charger le corpus en mémoire. Ce change remet donc la couche d'accès à l'échelle **avant** l'implémentation MCP (ordre : v0.6 échelle → v1 MCP). Le principe « corpus = archive, index = vue jetable » est **renforcé**, pas abandonné : la vue reste entièrement reconstruisable depuis le seul corpus, et devient en plus le chemin de lecture borné.

## Quoi change

- **MODIFIED/RENAMED (corpus)** — `Schéma canonique v1` devient `Schéma canonique et layout v2` : les **enregistrements** (événement, session) sont inchangés ; seul le layout des fichiers change — shards par session `events/<p>/<sessionId>.jsonl` (ordre `(ts, id)` stable, `<p>` = deux caractères hexadécimaux d'un **condensat déterministe de l'id** : les identifiants partagent tous un préfixe `ses_`/`prt_`, un préfixe tiré de leurs premiers caractères concentrerait tout dans un seul répertoire — retour du 20/09 soir), `sessions.jsonl` unique pour les métadonnées, `raw/<p>/<partId>.txt` shardé sur le même principe, `layoutVersion` dans `state.json` avec refus explicite des autres versions.
- **MODIFIED (corpus)** — `Ingestion incrémentale et idempotence` : coût d'une passe **borné par le delta lu, le volume des sessions touchées et les métadonnées de sessions** — jamais par le reste du corpus ni par un parcours complet de la source (watermark en requête) ; **protocole de publication** (**marqueur persistant d'ingestion en cours**, posé avant tout remplacement et retiré en dernier, staging sous noms temporaires, renames, COMMIT de la vue comme point de publication, `state.json`, ramassage des temporaires ; réconciliation par relance, **reprise explicite** sans source) avec contrat de crash explicite : chaque shard est atomique, la publication entre shards est éventuelle, **aucune lecture ne consulte les shards directement**, les opérations d'archive refusent tant que l'état n'est pas réconcilié — un crash après le dernier rename, avant le COMMIT, reste détectable par le marqueur ; verrou consultatif contre les ingestions concurrentes.
- **ADDED (corpus)** — `Vue dérivable en chemin de lecture` : l'index SQLite (jetable, reconstruisable) devient le chemin de lecture unique du CLI comme des façades futures — enregistrements complets, fenêtres bornées, refus explicite si vue absente ou périmée. Fraîcheur **honnête** : le watermark couvre le chemin d'ingestion documenté ; une modification hors ingestion n'est détectée que par l'empreinte. Le coût des compteurs (`maskedCount`) est un dénombrement sur la plage, couvert par le banc. Chaque commande de lecture s'exécute dans une **unique transaction de lecture SQLite** (un seul snapshot : aucune génération intercalée entre hits, voisins et compteurs), et les preuves potentiellement en avance sur la vue sont **signalées dans la sortie** tant que le marqueur d'ingestion en cours est présent.
- **ADDED (corpus)** — `Opérations en mémoire bornée` : aucune commande ne charge le corpus, la source ou une archive v1 en entier ; parcours en flux partout, **preuves lues par blocs** (la mémoire ne dépend pas de la taille d'un fichier raw) ; cible mesurée au banc.
- **ADDED (corpus)** — `Migration du corpus v1` : passage v1→v2 **sans la source**, en flux, idempotent, vérifié.
- **ADDED (corpus)** — `Empreinte déterministe du corpus` : agrégat md5 sur chemins triés, remplaçant le md5 d'un fichier unique dans les conditions d'évaluation — et outil de détection des modifications **hors ingestion**.
- **MODIFIED (search)** — `Interface Retriever` : l'indexation opère depuis le corpus **en flux**, jamais depuis un tableau matérialisé ; contrats inchangés.
- **MODIFIED (search)** — `Performance` : cibles re-visées à l'échelle et vérifiées sur un **banc synthétique déterministe mesurant le parcours utilisateur complet** (recherche rendue avec voisins, lecture `--at` avec compteurs, ingestion depuis une base source à structure opencode réelle, preuve volumineuse), conditions consignées (machine, cache, RSS, disque), hors `npm test`.
- **MODIFIED (search)** — `Recherche brute optionnelle` : scan `--raw` en flux et par blocs, coût O(raw/) documenté, mémoire bornée.

Aucun code dans ce change : spec d'abord (SDD), implémentation dans un change séparé, sur accord explicite.

## Impact

- **Specs** : `corpus` (1 renommée+modification, 2 modifications, 4 ajouts) et `search` (3 modifications). Les capacités `natural-eval` et le change ouvert `add-mcp-server` ne changent pas — la spec MCP reste valable telle quelle.
- **Code (à venir, hors de ce change)** : adaptateur en flux (watermark en requête indexée), écriture par shards, protocole de publication, vue SQLite étendue (JSON intégral + métadonnées de sessions), lecture read/around/ctx/tail/at par requêtes bornées, raw sharding et lecture par blocs, migration, empreinte, banc étendu. **Changement d'usage documenté** : `sdig read` devient dépendant de la vue dérivable (refus explicite si absente ou périmée, comme `search` aujourd'hui).
- **Évaluation** : `npm run eval` (28/28) doit rester vert — la sémantique de recherche ne change pas ; le harnais du jeu naturel épinglera l'intégrité du corpus par la nouvelle empreinte.
- **Hors périmètre** : embeddings (v2), sstats (v3), tout code MCP, changement du schéma des enregistrements, changement du scoring, multi-machine, compression du corpus.

## Ce que ce change protège

Interdire de répondre à une commande en chargeant l'archive entière ; interdire de réécrire le corpus entier pour un delta ; interdire de livrer une façade MCP dont les workers gonfleraient en RAM. Et préserver les acquis : idempotence octet par octet, ordre stable, source en lecture seule, archive locale jamais publiée, index entièrement reconstruisable. Les promesses non tenables ne sont pas écrites : le coût d'une passe est formulé honnêtement, la cohérence après crash est définie par un protocole testé, et la fraîcheur ne prétend pas voir ce qu'elle ne peut pas voir.
