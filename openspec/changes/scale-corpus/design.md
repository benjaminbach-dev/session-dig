# Design — scale-corpus

## D0 — Motivation et ordre des changes (20/09)

Contrainte utilisateur : le projet doit tourner ailleurs ; corpus 20-100× plus lourd au minimum, base source PC de 4 Go (contre ~4 Mo de corpus sur téléphone). Goulets vérifiés dans le code : `readJsonl` plein-fichier (utilisé par read/raw/search CLI/ingest), `ingest` à réécriture intégrale, `raw/` plat. La recherche tient déjà (SQL pur — à confirmer au banc, cf. D5). Décision : passe échelle **avant** l'implémentation MCP — sinon la façade hérite des parcours complets et le contrat D9 du MCP (isolation du travail, timeout) enveloppe des lectures O(corpus).

Ce change est **documentaire**. Les nombres sont des bornes de conception, à vérifier et ajuster avec mesure ; les principes (mémoire bornée, idempotence, archive de référence, promesses tenables), eux, ne sont pas négociables. Retour du 20/09 soir (revue utilisateur) intégré : préfixe de sharding par condensat, protocole de publication, formule de coût honnête, coût des compteurs, banc sur parcours complet.

## D1 — Layout v2 : shards par session, préfixe par condensat

- `events/<p>/<sessionId>.jsonl`, une ligne par événement, ordre `(ts, id)` dans le shard, stable entre ingestions identiques.
- `raw/<p>/<partId>.txt` sur le même principe.
- **`<p>` = deux premiers caractères hexadécimaux d'un condensat déterministe de l'identifiant** (256 répertoires ; le condensat précis — md5, sha1, FNV — est épinglé à l'implémentation). Retour du 20/09 soir : les identifiants opencode partagent tous un préfixe constant (`ses_`, `prt_`), donc un préfixe tiré des premiers caractères de l'id **concentrerait 100 % des fichiers dans `events/se/` et `raw/pr/`** — la répartition ne répartirait rien. Le condensat, lui, répartit uniformément et reste déterministe (rebuild identique → mêmes chemins).
- `sessions.jsonl` reste un flux unique (métadonnées, ordre `id`) : sa réécriture est le seul coût O(#sessions) d'une ingestion — borné et documenté (~Mo à l'échelle visée).
- `state.json` porte `layoutVersion: 2`. Tout outil refuse explicitement une autre version de layout (message nommant la version lue et attendue) — jamais d'interprétation implicite d'un layout inconnu.
- **Pourquoi des shards plutôt qu'un fichier unique + offsets** : append-only naturel, ingestion sans réécriture globale, réparabilité par shard, pas d'index d'offsets à maintenir en cohérence avec les réécritures. Contre-coût assumé : beaucoup de petits fichiers, mitigé par la répartition en 256 répertoires ; ajouter un message à une session géante réécrit son shard entier — le prix du layout, documenté.
- Les **enregistrements** (schéma d'un événement, d'une session) sont strictement inchangés : `schemaVersion` des lignes reste 1 ; seule la découpe des fichiers et leur nommage changent, portés par `layoutVersion`.

## D2 — La vue dérivable devient le chemin de lecture

- L'index SQLite (aujourd'hui dédié à la recherche) s'étend en **vue de lecture** : table des événements avec le JSON intégral de chaque enregistrement + colonnes filtrables + FTS5, et table des sessions (métadonnées complètes).
- `read` (`--around`, `--ctx`, `--tail`, `--at`), les voisins de recherche et `status` s'y exécutent par **requêtes bornées** (fenêtres cléset sur `(sessionId, ts, id)`) : O(log n + k), mémoire bornée par la fenêtre.
- La logique métier (résolution d'ancre, masquage avant fenêtrage, marqueurs, troncature) est **conservée telle quelle** — seul l'accès aux données change. La sémantique CLI observable reste celle des specs `search` en vigueur.
- **Compteurs** : `maskedCount`, `visible`, `total` restent exacts. Leur calcul est un dénombrement sur la plage indexée de la session — coût O(plage), pas O(fenêtre) : masquer tôt dans une session de 100 000 messages dénombre ~100 000 lignes via l'index. Ce coût est couvert par les cibles du banc (mesuré sur la session géante), pas caché derrière « fenêtre bornée ».
- **Fraîcheur** : la vue porte en son sein le watermark du corpus auquel elle correspond ; toute lecture vérifie et **refuse explicitement** une vue absente ou périmée (avec l'instruction de réparation). `sdig read` devient dépendant de la vue — changement d'usage documenté dans le README. **Limite écrite au lieu d'implicite** (retour du 20/09 soir) : le watermark couvre le **chemin d'ingestion documenté** — il détecte un corpus plus récent que la vue. Une modification **hors ingestion** (shard édité à la main, watermark inchangé) n'est pas détectée par la fraîcheur ; l'outil de détection est l'empreinte (D7). Deux outils, deux usages, aucune promesse de couverture croisée.
- Le contrat « index jetable » est inchangé : entièrement reconstruisable depuis le seul corpus. En plus, la vue est **maintenue incrémentalement** pendant l'ingestion (insertions/suppressions ciblées) ; le rebuild complet reste la référence de réparation. En cas de divergence non résolue, le rebuild depuis le corpus fait foi.

## D3 — Coût d'une passe et protocole de publication

**Formule de coût honnête** (retour du 20/09 soir : « O(delta) » survendait) : une passe incrémentale coûte

> delta lu dans la source + volume des sessions touchées + réécriture des métadonnées de sessions (O(#sessions))

— et rien d'autre : jamais le volume du reste du corpus, jamais un parcours complet de la source. Deux implications concrètes :
- la lecture incrémentale de la source SHALL utiliser le watermark **en requête** (filtre sur `time_updated` exécuté par la base, appuyé sur ses index) — pas un parcours complet des tables filtré après coup ;
- ajouter un message à une session géante réécrit le shard de cette session : c'est le prix du layout, documenté et couvert par le banc.

**Protocole de publication** (retour du 20/09 soir : des renames atomiques par fichier + `state.json` en dernier ne font pas une transaction entre shards, métadonnées, preuves et SQLite) :

1. **Staging** : chaque fichier réécrit est d'abord écrit sous un nom temporaire (`.new`) ; la vue SQLite accumule ses changements dans une transaction ouverte, non validée.
2. **Publication** : renames des fichiers préparés → **COMMIT de la transaction de la vue** → écriture de `state.json`, en dernier.
3. **Ramassage** : les temporaires orphelins (crash avant publication) sont supprimés à la passe suivante.

**Le COMMIT de la vue est le point de publication.** Conséquences contractuelles :
- chaque shard est publié atomiquement (rename) — **jamais de shard déchiré** ;
- entre shards, la publication est **éventuelle** : un crash pendant les renames peut laisser sur disque un mélange de générations de shards — mais **aucune commande de lecture ne consulte les shards directement** (elles passent par la vue, dont la transaction est atomique) : les lectures rendent toujours le **dernier état publié**, cohérent ;
- un crash entre COMMIT et `state.json` laisse la vue **en avance** sur `state.json` : c'est un état publié valide ; la passe suivante relit le delta depuis l'ancien watermark et ré-applique idempotemment — convergence garantie sans doublon ;
- une **preuve brute** consultée pendant une publication interrompue peut être en avance sur la vue (raw publié avant le COMMIT) : transitoire documenté, réparé à la passe suivante ;
- les parcours d'archive (rebuild, empreinte, migration) peuvent observer l'état intermédiaire (temporaires présents, `state.json` en retard) : ils le **signalent** au lieu de l'ignorer ;
- la passe suivante converge toujours vers le même résultat qu'une passe unique.

**Verrou** : flock sur le corpus contre deux ingestions concurrentes ; les lecteurs ne verrouillent pas (WAL + renames atomiques).

**Tests de points de crash** (à écrire avec l'implémentation) : avant staging, pendant staging, entre renames, après COMMIT avant `state.json` — dans chaque cas : lectures = dernier état publié, passe suivante converge, temporaires ramassés.

## D4 — Mémoire bornée, partout

- Aucune commande (ingest, index, read, raw, search, `--raw`, status, migration) ne charge le corpus, la base source ou une archive v1 dans son intégralité en mémoire.
- Le `readJsonl` plein-fichier devient un usage **interdit sur les chemins de commande** ; le streaming (ligne à ligne, par lots) est la règle pour migration et rebuild.
- **Preuves par blocs** (retour du 20/09 soir : « fichier par fichier » ne suffit pas si un seul raw est gigantesque) : l'affichage (`sdig raw`) et le scan (`--raw`) lisent chaque fichier par **blocs bornés** avec recouvrement aux frontières pour les matches — l'empreinte mémoire ne dépend ni du nombre ni de la taille des fichiers raw.
- Cible de conception : empreinte < 512 Mo pour toute opération du banc à 500 000 événements (mesurée et consignée, RSS maximale).

## D5 — Banc synthétique : le parcours utilisateur complet

- Extension du banc existant (`scripts/bench.mjs`) : générateur **déterministe** (graine épinglée) produisant un corpus synthétique réaliste — tailles de sessions inégales (dont des sessions monstres ~10 000 messages), messages longs, toolCalls, fichiers raw volumineux (dont quelques géants).
- **Base source synthétique reprenant la structure réelle d'opencode.db** (tables `session`/`message`/`part`, mêmes colonnes) : l'ingestion initiale et les deltas sont mesurés depuis une vraie forme de source, pas d'un corpus pré-construit.
- **Ce qui est mesuré = le parcours complet, pas la seule couche FTS5** (retour du 20/09 soir : « SQL pur » n'est pas une preuve à 100×) : recherche avec rendu groupé par session et voisins `--ctx` ; lecture de session avec `--at` et compteurs exacts ; ingestion initiale ; delta d'ingestion ; lecture de preuve volumineuse.
- **Conditions consignées** : machine, cache chaud/froid (mesures répétées), RSS maximale, espace disque temporaire utilisé.
- Volumes : **100× le corpus réel actuel (~500 000 événements) par défaut**, 1000× en option. Mesures consignées dans le dépôt ; le banc n'entre **pas** dans `npm test` (durée).
- Cibles de conception (vérifiées au banc, ajustées avec justification sinon) : recherche p95 < 100 ms @ 500k (parcours rendu) ; lecture `--at` avec compteurs p95 < 100 ms sur session de 10 000 messages ; delta d'ingestion ≤ 1 000 événements < 10 s sur corpus d'un million ; rebuild complet du banc < 5 min.

## D6 — Migration v1 → v2 sans source

- Une commande dédiée transforme un corpus v1 (flux uniques) en v2 : streaming ligne à ligne, jamais le corpus entier en RAM.
- Idempotente : relancer ne change rien. Vérifiée : comptes d'événements et de sessions conservés et annoncés ; les incohérences (ligne illisible, session sans événement) sont signalées, pas ignorées.
- Un corpus v1 face aux outils v2 → refus explicite avec la marche à suivre (migrer, ou re-ingérer depuis la source).

## D7 — Empreinte du corpus (conditions d'évaluation, détection hors ingestion)

- `sdig status` (ou option dédiée) rend une **empreinte déterministe** : md5 par fichier, agrégés sur les chemins relatifs **triés** — indépendante de l'ordre du système de fichiers.
- Coût O(taille du corpus), commande explicite et documentée : elle remplace le « md5 du corpus » des conditions du jeu naturel (harnais d'examen, runs futurs) et n'est jamais calculée sur le chemin des commandes de lecture.
- **Second rôle, écrit** (retour du 20/09 soir) : c'est l'outil de détection des modifications **hors ingestion** — ce que la fraîcheur par watermark ne peut pas voir (D2). L'empreinte voit tout changement de contenu ; elle ne dit pas lequel est légitime.

## D8 — Recherche brute `--raw`

- Reste opt-in et hors index (décision du 15/09 inchangée). Le scan s'exécute en **flux** (fichier par fichier, blocs bornés à l'intérieur de chaque fichier — D4), mémoire bornée, durée affichée ; son coût O(raw/) est documenté — une opération consciente, pas une surprise.

## D9 — Interaction avec la v1 MCP

- La spec MCP ouverte (`add-mcp-server`) reste valable **sans modification** : plafonds par appel, continuation et fraîcheur sont déjà size-agnostiques.
- Le change d'implémentation MCP ajoutera la contrainte « workers jamais de chargement complet du corpus » — satisfaite de facto par D2/D4 puisque la façade réutilise les mêmes fonctions que le CLI.
- Le défaut de délai MCP (5 s) restera configurable ; la documentation du MCP précisera de le relever sur corpus volumineux.

## D10 — Hors périmètre

Embeddings (v2), sstats (v3), tout code MCP, changement du schéma des enregistrements, changement du scoring ou de la sémantique de recherche, distribution multi-machine, compression du corpus.
