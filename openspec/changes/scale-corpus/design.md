# Design — scale-corpus

> **Recentrage effectué à la demande explicite de l'utilisateur.** Le jalon « usage solo local validé sur PC » (trois lots A/B/C, proposition de ce change) est la prochaine étape ; le premier usage MCP n'exige pas la clôture complète du change, mais les garde-fous bloquants (D3/D3bis) restent exigés avant usage sur corpus réel. Prototypage et tests sur fixtures isolées peuvent précéder ce jalon. La base PC de 4 Go est une motivation documentée, non revérifiée.

> **État d’implémentation révisé (20/09 soir)** : ce document décrit le contrat cible, pas une attestation de conformité. Implémentation et correctifs partiels livrés ; voir [progress.md](progress.md) et les tâches rouvertes. Les garanties de verrouillage/échelle restent à prouver.

## D0 — Motivation et ordre des changes (20/09)

Contrainte utilisateur : le projet doit tourner ailleurs ; corpus 20-100× plus lourd au minimum, base source PC de 4 Go — **motivation historique documentée, non revérifiée à ce jour** contre ~4 Mo de corpus sur téléphone. Les goulets de départ étaient `readJsonl` plein-fichier, l'ingestion à réécriture intégrale et `raw/` plat ; ils ne décrivent pas tous le code actuel (correctifs dans progress.md). Le SQL FTS5 ne constitue pas à lui seul une preuve de tenue à l'échelle. Le socle livré est conservé : intégrité et accès bornés utilisés par le MCP avant usage réel, validation sur PC, optimisations supplémentaires selon les mesures ; pas d'attente de clôture globale avant le MVP.

Ce recentrage est **documentaire** et ne modifie pas le code livré. Les nombres sont des cibles de conception à vérifier et ajuster ; restent essentiels l'absence de chargement global des événements, l'idempotence, l'archive de référence et des coûts explicités plutôt que des promesses universelles. Retour du 20/09 soir (revue utilisateur) intégré : préfixe de sharding par condensat, protocole de publication, formule de coût honnête, coût des compteurs, banc sur parcours complet.

## D1 — Layout v2 : shards par session, préfixe par condensat

- `events/<p>/<sessionId>.jsonl`, une ligne par événement, ordre `(ts, id)` dans le shard, stable entre ingestions identiques.
- `raw/<p>/<partId>.txt` sur le même principe.
- **`<p>` = deux premiers caractères hexadécimaux d'un condensat déterministe de l'identifiant** (256 répertoires ; le condensat précis — md5, sha1, FNV — est épinglé à l'implémentation). Retour du 20/09 soir : les identifiants opencode partagent tous un préfixe constant (`ses_`, `prt_`), donc un préfixe tiré des premiers caractères de l'id **concentrerait 100 % des fichiers dans `events/se/` et `raw/pr/`** — la répartition ne répartirait rien. Le condensat, lui, répartit uniformément et reste déterministe (rebuild identique → mêmes chemins).
- `sessions.jsonl` reste un flux unique (métadonnées, ordre `id`) : sa réécriture coûte O(#sessions), comme peuvent le faire certains inventaires et structures de suivi. Ces coûts sont documentés et mesurés, pas assimilés à O(delta).
- `state.json` porte `layoutVersion: 2`. Tout outil refuse explicitement une autre version de layout (message nommant la version lue et attendue) — jamais d'interprétation implicite d'un layout inconnu.
- **Pourquoi des shards plutôt qu'un fichier unique + offsets** : isolation des réécritures par session, ingestion sans réécriture globale, réparabilité par shard, pas d'index d'offsets à maintenir en cohérence avec les réécritures. Contre-coût assumé : beaucoup de petits fichiers, mitigé par la répartition en 256 répertoires ; ajouter un message à une session géante réécrit son shard entier — le prix du layout, documenté.
- Les **enregistrements** (schéma d'un événement, d'une session) sont strictement inchangés : `schemaVersion` des lignes reste 1 ; seule la découpe des fichiers et leur nommage changent, portés par `layoutVersion`.

## D2 — La vue dérivable devient le chemin de lecture

- L'index SQLite (aujourd'hui dédié à la recherche) s'étend en **vue de lecture** : table des événements avec le JSON intégral de chaque enregistrement + colonnes filtrables + FTS5, et table des sessions (métadonnées complètes).
- `read` (`--around`, `--ctx`, `--tail`, `--at`), les voisins de recherche et `status` s'y exécutent par **requêtes bornées** (fenêtres cléset sur `(sessionId, ts, id)`) : O(log n + k), mémoire bornée par la fenêtre.
- La logique métier (résolution d'ancre, masquage avant fenêtrage, marqueurs, troncature) est **conservée telle quelle** — seul l'accès aux données change. La sémantique CLI observable reste celle des specs `search` en vigueur.
- **Snapshot de lecture** (retour du 20/09 soir, 2e point) : toutes les requêtes d'une même commande (hits → voisins → compteurs) s'exécutent dans une **unique transaction de lecture SQLite** — une publication concurrente ne s'intercale pas dans une lecture en cours ; c'est ce qui rend tenable « pas de mélange de générations » au sein d'une commande.
- **Compteurs** : `maskedCount`, `visible`, `total` restent exacts. Leur calcul est un dénombrement sur la plage indexée de la session — coût O(plage), pas O(fenêtre) : masquer tôt dans une session de 100 000 messages dénombre ~100 000 lignes via l'index. Ce coût est relevé sur PC puis au banc si nécessaire, pas caché derrière « fenêtre bornée ».
- **Fraîcheur** : la vue porte en son sein le watermark du corpus auquel elle correspond ; toute lecture vérifie et **refuse explicitement** une vue absente ou périmée (avec l'instruction de réparation). `sdig read` devient dépendant de la vue — changement d'usage documenté dans le README. **Limite écrite au lieu d'implicite** (retour du 20/09 soir) : le watermark couvre le **chemin d'ingestion documenté** — il détecte un corpus plus récent que la vue. Une modification **hors ingestion** (shard édité à la main, watermark inchangé) n'est pas détectée par la fraîcheur ; l'outil de détection est l'empreinte (D7). Deux outils, deux usages, aucune promesse de couverture croisée.
- Le contrat « index jetable » est inchangé : entièrement reconstruisable depuis le seul corpus. En plus, la vue est **maintenue incrémentalement** pendant l'ingestion (insertions/suppressions ciblées) ; le rebuild complet reste la référence de réparation. En cas de divergence, la réparation depuis le corpus suit D3 : pas de rebuild ordinaire sur une publication non réconciliée. La fraîcheur est vérifiée par source ; une divergence de jeton pi rend la vue fusionnée indisponible jusqu'à réconciliation.

## D3 — Coût d'une passe et protocole de publication

**Coûts explicités** : en passe normale sur vue saine, pas de réécriture du corpus entier pour un delta. Le coût comprend le delta retourné par opencode, la découverte/stat des fichiers Pi et la relecture des fichiers Pi changés, les sessions touchées, ainsi que les métadonnées et inventaires de sessions/fichiers. Une réparation ou reconstruction reste un parcours complet explicite.

- Opencode : filtre watermark SQL sur `time_updated`, pas filtrage applicatif d'une table entièrement matérialisée. L'index source n'est pas garanti et le plan dépend de SQLite ; un scan source peut rester nécessaire. Le plan et le coût sont vérifiés/consignés sur PC, sans modification implicite de la source pour créer un index.
- Pi : la relecture complète d'un fichier changé reste le contrat actuel ; une reprise à l'octet n'est pas requise pour ce jalon.
- Ajouter un message à une session géante peut réécrire son shard : prix du layout, assumé et mesuré. Les structures par session/fichier sont détaillées en D4.

**Protocole de publication** (retour du 20/09 soir : des renames atomiques par fichier + `state.json` en dernier ne font pas une transaction entre shards, métadonnées, preuves et SQLite) :

1. **Marqueur** : un marqueur persistant d'ingestion en cours est posé **avant tout remplacement de fichier** et retiré en tout dernier (après `state.json`). Un crash après le dernier rename, avant le COMMIT, ne laisse plus de `.new` ni d'écart de `state.json` — le marqueur est le seul détecteur fiable de cet état (retour du 20/09 soir).
2. **Staging** : chaque fichier réécrit est d'abord écrit sous un nom temporaire (`.new`) ; la vue SQLite accumule ses changements dans une transaction ouverte, non validée.
3. **Publication** : renames des fichiers préparés → **COMMIT de la transaction de la vue** → écriture de `state.json` → retrait du marqueur.
4. **Ramassage** : les temporaires orphelins (crash avant publication) sont supprimés à la passe suivante.

**Le COMMIT de la vue est le point de publication.** Conséquences contractuelles :
- chaque shard est publié atomiquement (rename) — **jamais de shard déchiré** ;
- entre shards, la publication est **éventuelle** : un crash pendant les renames peut laisser sur disque un mélange de générations de shards — mais **aucune commande de lecture ne consulte les shards directement** (elles passent par la vue, dont la transaction est atomique) : les lectures réussies rendent un **état publié cohérent** ; une vue absente ou dont la fraîcheur n'est pas établie est refusée explicitement ;
- un crash entre COMMIT et `state.json` laisse la vue **en avance** : si sa fraîcheur peut être établie (cas opencode sans divergence pi), elle peut être lue. Une divergence de jeton pi entraîne au contraire le refus temporaire de la vue fusionnée jusqu'à réconciliation depuis les shards puis état cohérent, selon `add-pi-adapter`. La relance converge sans doublon ; aucune disponibilité permanente n'est promise ;
- une **preuve brute** consultée pendant une publication interrompue peut être en avance sur la vue (raw publié avant le COMMIT) : transitoire documenté, **signalé dans la sortie** tant que le marqueur est présent (l'avertissement nomme l'état non réconcilié et la marche à suivre), réparé à la passe suivante ;
- **réconciliation, régie par le marqueur** : tant qu'il est présent, les lectures structurées sont permises seulement si la vue publiée et sa fraîcheur sont établies ; sinon elles refusent. Les lectures de preuves autorisées affichent l'avertissement ; les opérations d'archive (rebuild, empreinte, migration) **refusent** avec la marche à suivre — un crash après le dernier rename, avant le COMMIT, ne laisse ni `.new` ni `state.json` en retard : sans marqueur, cet état serait indétectable et un rebuild transformerait un état non publié en référence (retour du 20/09 soir) ;
- **reprise sans source** : à défaut de source, une reprise **explicite** assume l'état sur disque — vue reconstruite depuis le corpus tel qu'il est, watermark de `state.json` conservé (la prochaine ingestion depuis la source convergera), marqueur retiré — décision d'opérateur consignée, jamais le défaut d'un rebuild ;
- la passe suivante converge toujours vers le même résultat qu'une passe unique.

### D3bis — Exclusion d'écrivains : contrat, pas mécanisme

Au plus **un écrivain** (ingest, index/rebuild, migrate, recover) sur le corpus. Une mutation concurrente échoue proprement avec motif et marche à suivre ; pas d'écritures entrelacées. Les parcours d'archive, dont **fingerprint qui est en lecture seule**, sont protégés contre une mutation pendant toute leur durée, pas seulement par un contrôle initial. Une exclusion commune est suffisante pour l'usage solo ; aucun verrou lecteur/écrivain sophistiqué n'est imposé.

Le mécanisme n'est pas imposé (flock, création exclusive, autre) : il doit être validé par **tests multi-processus ciblés**. Pour wx/PID, couvrir notamment reprise/release simultanées, propriétaire mort, verrou vide/illisible et identité de propriétaire ambiguë ; en cas de doute, refuser et demander une intervention plutôt que reprendre un verrou potentiellement vivant. L'implémentation actuelle reste partielle, pas déclarée sûre. Les lecteurs de la vue SQLite ne prennent pas ce verrou : snapshot et fraîcheur, ou refus explicite.

**Tests de points de crash** (à écrire avec l'implémentation) : avant staging, pendant staging, entre renames, **après le dernier rename avant COMMIT (détection par le marqueur — plus aucun `.new`)**, après COMMIT avant `state.json` — dans chaque cas : lectures réussies sur état publié cohérent ou refus explicite (dont divergence pi), opérations d'archive refusées via le marqueur s'il est posé, avertissement preuves, relance convergente et temporaires ramassés. Les arrêts de processus aux transitions critiques sont testés réellement ; cela ne vaut pas preuve de durabilité face à une panne matérielle. Plus un test de snapshot : publication concurrente pendant une lecture multi-étapes (hits → voisins → compteurs) — un seul snapshot par commande, jamais de génération intercalée.

## D4 — Mémoire bornée, avec des coûts formulés honnêtement

- Aucune commande (ingest, index, read, raw, search, `--raw`, status, migration) ne matérialise le corpus, la source ou une archive v1 **globalement** en mémoire sur les chemins usuels.
- Streaming par lots pour migration/rebuild ; accès par fenêtres pour read/contextes et par fragments pour MCP. Ne pas matérialiser une session entière pour rendre une fenêtre ou une page. La relecture intégrale d'un **fichier source Pi changé** reste admise et son coût doit être mesuré ; ce n'est pas un chargement global du répertoire source.
- **Preuves par blocs** (retour du 20/09 soir : « fichier par fichier » ne suffit pas si un seul raw est gigantesque) : l'affichage (`sdig raw`) et le scan (`--raw`) lisent chaque fichier par **blocs bornés** avec recouvrement aux frontières pour les matches — la mémoire ne dépend pas de la taille d'un fichier raw.
- **Coûts restants** : fichier Pi changé lu intégralement, delta d'une session (`cur.evs`), sessions touchées et renames retenus pendant la passe, métadonnées et inventaires (`listShards`) pouvant dépendre de l'ensemble des sessions/fichiers. Pas de promesse de mémoire indépendante du corpus pour ces structures. Mesurer leur impact sur le PC ; corriger les blocages observés, pas imposer de quotas arbitraires préventifs. Toute limite appliquée doit être annoncée ; jamais de résultat partiel silencieusement présenté comme complet.
- Cible de conception : empreinte < 512 Mo pour toute opération du banc à 500 000 événements (mesurée et consignée, RSS maximale) — cible, pas garantie contractuelle.

## D5 — Banc synthétique : le parcours utilisateur complet

- Extension du banc existant (`scripts/bench.js`) : générateur **déterministe** (graine épinglée) produisant un corpus synthétique réaliste — tailles de sessions inégales (dont des sessions monstres ~10 000 messages), messages longs, toolCalls, fichiers raw volumineux (dont quelques géants).
- **Base source synthétique reprenant la structure réelle d'opencode.db** (tables `session`/`message`/`part`, mêmes colonnes) : l'ingestion initiale et les deltas sont mesurés depuis une vraie forme de source, pas d'un corpus pré-construit.
- **Ce qui est mesuré = le parcours complet, pas la seule couche FTS5** (retour du 20/09 soir : « SQL pur » n'est pas une preuve à 100×) : recherche avec rendu groupé par session et voisins `--ctx` ; lecture de session avec `--at` et compteurs exacts ; ingestion initiale ; delta d'ingestion ; lecture de preuve volumineuse.
- **Conditions consignées** : machine, cache chaud/froid (mesures répétées), RSS maximale, espace disque temporaire utilisé.
- Volumes (lot C du jalon, conditionnel) : **500 000 événements (ancien objectif 100×)**, 1000× en option — objectifs justifiés, **pas un prérequis universel** du premier jalon d'usage solo local ; l'instrument (banc) SHALL être rendu fidèle (rendu mesuré, grosse preuve générée, RSS maximale) **avant** toute mesure d'échelle. Mesures consignées dans le dépôt ; le banc n'entre **pas** dans `npm test` (durée).
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

- La spec MCP ouverte (`add-mcp-server`) est **amendée** (rescopage MVP à la demande de l'utilisateur : search/read/status ; raw et son durcissement reportés ; contrat de concurrence honnête). Réponses plafonnées, continuation de read et fraîcheur restent requises ; pas de pagination search dans le MVP.
- Toutes les lectures MCP passent par les **requêtes SQL bornées** de la vue (D2) : jamais de matérialisation globale du corpus ou d'une source sur un chemin MCP ; une lecture réussie est cohérente (un snapshot), pas une promesse de disponibilité permanente (divergence jeton pi ⇒ `view_unavailable` temporaire, cf. spec MCP).
- Le change MCP doit vérifier et au besoin adapter les fonctions partagées : le lecteur CLI complet matérialise encore une session (progress.md). D2/D4 sont des exigences à valider, pas une conformité acquise ; une réponse paginée après chargement intégral ne suffit pas.
- **Pas de timeout applicatif MCP au MVP** (le délai 5 s antérieur est reporté, voir add-mcp-server) : une exécution MCP peut durer plus longtemps sur un gros corpus ; le contrat le dit honnêtement (aucune garantie de durée) et l'amélioration ultérieure (timeout strict avec arrêt observable) reste conditionnée à une demande explicite.

## D10 — Hors périmètre

Embeddings (v2), sstats (v3), tout code MCP, changement du schéma des enregistrements, changement du scoring ou de la sémantique de recherche, distribution multi-machine, compression du corpus.
