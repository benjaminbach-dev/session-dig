# Delta corpus — scale-corpus

## RENAMED Requirements

- FROM: `### Requirement: Schéma canonique v1`
- TO: `### Requirement: Schéma canonique et layout v2`

## MODIFIED Requirements

### Requirement: Schéma canonique et layout v2

Le corpus SHALL être composé d'enregistrements canoniques **inchangés depuis la v1** : un événement par message, portant `id`, `sessionId`, `ts` (ms epoch), `role` (`user` ou `assistant`), `text`, `model` (`providerID`, `modelID`), `agent`, `repo`, `tokens` (`in`, `out`, `reasoning`, `cacheRead`, `cacheWrite`) et `cost`. Un événement MAY porter un champ `toolCalls` — liste de `{tool, cmd, exitCode?, rawRef?}` — pour les messages contenant des appels d'outils (décision du 16/09 : liste et non champ unique, les données réelles montrant jusqu'à 34 appels par message) ; `exitCode` est omis quand la source ne l'expose pas ; `rawRef` référence la sortie brute dans `raw/` quand elle existe. Une session SHALL contenir : `id`, `schemaVersion`, `title`, `directory`, `repo`, `tsCreated`, `tsUpdated`, `cost`, `tokens`. Chaque ligne SHALL porter `schemaVersion: 1` : le schéma des enregistrements ne change pas avec ce change.

Décision du 20/09 (change `scale-corpus`, contrainte d'échelle : corpus 20-100× plus lourd au minimum, base source PC de 4 Go constatée) : le **layout des fichiers** passe en v2 pour tenir cette échelle. Les événements vivent dans un shard par session : `events/<p>/<sessionId>.jsonl` (une ligne par événement, ordonnés par (`ts`, `id`), stables entre deux ingestions identiques). Les métadonnées de sessions vivent dans `sessions.jsonl` (une ligne par session, ordonnées par `id`, stables). Les sorties brutes vivent dans `raw/<p>/<partId>.txt`. **`<p>` est le préfixe de répartition** : deux premiers caractères hexadécimaux d'un condensat déterministe de l'identifiant (condensat épinglé à l'implémentation). Retour du 20/09 soir : les identifiants partagent un préfixe constant (`ses_`, `prt_`) — un préfixe tiré des premiers caractères de l'id concentrerait la totalité des fichiers dans un seul répertoire ; le condensat répartit uniformément tout en restant déterministe (une reconstruction identique produit les mêmes chemins). `state.json` SHALL porter un champ `layoutVersion`. Tout outil SHALL refuser explicitement un corpus dont le `layoutVersion` diffère de celui qu'il comprend, en nommant la version lue et la version attendue — jamais de lecture ou d'écriture implicite d'un layout inconnu. Ré-ingestionner ou reconstruire depuis la même source SHALL produire le même ensemble de fichiers, chaque fichier identique octet par octet.

#### Scenario: Message utilisateur simple

- **WHEN** un message `user` sans appel d'outil est ingéré
- **THEN** l'événement contient role, text, model, tokens et cost, et aucun champ `toolCall`.

#### Scenario: Message avec appels d'outils

- **WHEN** un message `assistant` contient une ou plusieurs parts de type `tool`
- **THEN** l'événement porte `toolCalls` avec, pour chaque appel, l'outil et la commande ; `exitCode` est renseigné si la source l'expose ; `rawRef` référence la sortie brute écrite dans `raw/`.

#### Scenario: Sharding par session

- **WHEN** un corpus v2 contient les événements de plusieurs sessions
- **THEN** chaque session a exactement un shard `events/<p>/<sessionId>.jsonl`, ordonné par (`ts`, `id`), et aucune ligne d'événement n'existe ailleurs.

#### Scenario: Répartition indépendante du préfixe des identifiants

- **WHEN** des milliers de sessions dont les identifiants commencent tous par le même préfixe (`ses_`) — et des preuves dont les identifiants commencent tous par `prt_` — sont écrites
- **THEN** les fichiers se répartissent entre les répertoires du condensat sans concentration : aucun répertoire ne reçoit une part dominante des fichiers.

#### Scenario: Reconstruction identique

- **WHEN** le corpus est reconstruit intégralement depuis la même source
- **THEN** l'ensemble des fichiers est identique et chaque fichier (shards d'événements, `sessions.jsonl`) est identique octet par octet à la construction précédente — mêmes contenus, mêmes chemins.

#### Scenario: Version de layout refusée

- **WHEN** un outil comprenant le layout v2 rencontre un corpus v1 (sans `layoutVersion`, ou `layoutVersion: 1`)
- **THEN** il échoue avec un message nommant la version lue et la version attendue, sans lire ni écrire le corpus.

### Requirement: Parts non textuelles en v0

Décision du 16/09 (constat d'implémentation) : en v0, l'adaptateur opencode SHALL extraire les parts de type `text` (texte), `tool` (appels) et `step-finish` (tokens/cost) et SHALL ignorer les autres types (`reasoning`, `patch`, `snapshot`, `step-start`, `compaction`, `agent`, `file`). Cette sélection reste réversible : le corpus étant dérivable de la source par rebuild complet, ces parts pourront être ajoutées au schéma canonique dans une version ultérieure sans migration.

#### Scenario: Part de raisonnement ignorée

- **WHEN** un message contient une part `reasoning`
- **THEN** son texte n'entre ni dans `text` ni dans l'index de recherche, et aucune erreur n'est produite.

#### Scenario: Ordre stable

- **WHEN** le corpus est reconstruit intégralement depuis la même source
- **THEN** chaque fichier du corpus (shards d'événements et `sessions.jsonl`) est identique octet par octet à la construction précédente.

### Requirement: Ingestion incrémentale et idempotence

L'ingestion SHALL être incrémentale : un état interne (watermark sur `time_updated` des messages et sessions) détermine ce qui doit être relu. Ingestionner deux fois la même source SHALL produire zéro doublon et zéro divergence dans les sorties. Un rebuild complet depuis zéro SHALL produire le même corpus, et SHALL rester disponible comme option de réparation.

Décision du 20/09 (change `scale-corpus`, resserrée sur retour du soir) : le coût d'une passe incrémentale SHALL dépendre du **delta lu dans la source, du volume des sessions touchées et de la réécriture des métadonnées de sessions** (O(#sessions)) — et de rien d'autre : jamais du volume du reste du corpus, jamais d'un parcours complet de la source. La lecture incrémentale de la source SHALL utiliser le watermark **en requête** (filtre exécuté par la base sur `time_updated`, appuyé sur ses index), pas un parcours complet des tables filtré après coup. Ajouter un message à une session géante réécrit le shard de cette session : c'est le prix du layout par session, assumé et documenté.

**Protocole de publication** : un **marqueur persistant d'ingestion en cours** (fichier dédié) est posé **avant tout remplacement de fichier** et retiré en tout dernier, après l'écriture de `state.json` ; chaque fichier réécrit est d'abord préparé sous un nom temporaire ; la publication exécute les renames, puis valide la transaction de la vue dérivable — **le COMMIT de la vue est le point de publication** — puis écrit `state.json` et retire le marqueur ; les temporaires orphelins sont ramassés à la passe suivante. Conséquences contractuelles : chaque shard est publié atomiquement — jamais de shard déchiré ; entre shards, la publication est **éventuelle** (un crash pendant les renames peut laisser sur disque un mélange de générations de shards), mais **aucune commande de lecture ne consulte les shards directement** : les lectures passent par la vue et rendent toujours le **dernier état publié**, cohérent. Un crash entre le COMMIT et `state.json` laisse la vue en avance sur `state.json` — un état publié valide, que la passe suivante ré-applique idempotemment. Une preuve brute consultée pendant une publication interrompue peut être en avance sur la vue (raw publié avant le COMMIT) : transitoire documenté, **signalé dans la sortie** tant que le marqueur est présent, réparé à la passe suivante. Les parcours d'archive (rebuild, empreinte, migration) sont régis par le marqueur : tant qu'il est présent, l'état n'est pas réconcilié et ils **refusent** avec la marche à suivre — un crash après le dernier rename, avant le COMMIT, ne laisse plus de fichier temporaire ni d'écart de `state.json` détectable autrement. La réconciliation est la relance de l'ingestion — idempotente, elle reconverge et retire le marqueur. À défaut de source, une **reprise explicite** (décision d'opérateur, jamais implicite) assume l'état sur disque : la vue est reconstruite depuis le corpus tel qu'il est, le watermark de `state.json` est conservé (la prochaine ingestion depuis la source convergera) — un rebuild par défaut ne transforme jamais un état non publié en référence. La passe suivante converge toujours vers le même résultat qu'une passe unique. L'ingestion SHALL prendre un verrou consultatif sur le corpus pour empêcher deux ingestions concurrentes ; les lecteurs ne verrouillent pas.

#### Scenario: Double ingestion

- **WHEN** la commande d'ingestion est exécutée deux fois de suite sans changement de la source
- **THEN** les fichiers du corpus sont inchangés et aucun événement dupliqué n'apparaît.

#### Scenario: Source évolutive

- **WHEN** de nouveaux messages ont été écrits depuis la dernière ingestion
- **THEN** seuls les messages et sessions nouveaux ou modifiés sont relus (watermark en requête indexée, pas de parcours complet des tables) et seuls les shards des sessions touchées sont réécrits — les autres fichiers ne sont ni lus ni réécrits.

#### Scenario: Ingestions concurrentes

- **WHEN** deux ingestions sont lancées simultanément sur le même corpus
- **THEN** le verrou fait attendre ou échouer proprement la seconde ; aucune écriture entrelacée ne peut produire un fichier de corpus corrompu.

#### Scenario: Interruption avant le point de publication

- **WHEN** une ingestion est interrompue avant le COMMIT de la vue (pendant le staging ou les renames)
- **THEN** toutes les lectures rendent le dernier état publié — cohérent, inchangé pour elles ; les temporaires éventuels sont ignorés puis ramassés à la passe suivante, qui converge.

#### Scenario: Interruption après le point de publication

- **WHEN** une ingestion est interrompue entre le COMMIT de la vue et l'écriture de `state.json`
- **THEN** les lectures rendent le nouvel état (publié, cohérent) ; la passe suivante relit le delta depuis l'ancien watermark, ré-applique sans doublon et met `state.json` à jour.

#### Scenario: Marqueur d'ingestion en cours

- **WHEN** une ingestion est interrompue après le dernier rename mais avant le COMMIT — plus aucun fichier temporaire, shards déjà remplacés, vue et `state.json` encore à l'ancien état
- **THEN** le marqueur persistant est encore présent : une opération d'archive (rebuild, empreinte, migration) refuse avec la marche à suivre, et une lecture touchant des preuves brutes affiche l'avertissement.

#### Scenario: Réconciliation par relance

- **WHEN** l'ingestion est relancée alors que le marqueur est présent
- **THEN** elle rejoue la passe depuis le watermark de `state.json` (idempotente), converge, retire le marqueur et ramasse les temporaires éventuels.

#### Scenario: Reprise explicite sans source

- **WHEN** la source est indisponible et que l'opérateur décide d'assumer l'état sur disque
- **THEN** une reprise explicite reconstruit la vue depuis le corpus tel qu'il est, conserve le watermark de `state.json` et retire le marqueur — décision explicite, jamais le comportement par défaut d'un rebuild.

#### Scenario: Preuve potentiellement en avance, signalée

- **WHEN** une preuve brute est consultée alors que le marqueur d'ingestion en cours est présent
- **THEN** la sortie porte un avertissement explicite (preuve potentiellement plus récente que la vue), en plus de la preuve demandée.

## ADDED Requirements

### Requirement: Vue dérivable en chemin de lecture

Décision du 20/09 (change `scale-corpus`) : la vue dérivable SQLite — l'index, aujourd'hui dédié à la recherche — devient le **chemin de lecture unique** des données structurées, pour le CLI comme pour toute façade future (MCP). Elle SHALL contenir l'intégralité des enregistrements canoniques (JSON intégral par événement) et les métadonnées de sessions, avec un accès ordonné par (`sessionId`, `ts`, `id`). Les fenêtres de lecture (`--around`, `--ctx`, `--tail`, `--at`) et les voisins de recherche SHALL s'y exécuter comme des requêtes bornées : leur coût et leur empreinte mémoire dépendent de la fenêtre demandée, pas de la taille du corpus ni de la session. Toutes les requêtes d'une même commande de lecture — recherche avec ses voisins, lecture avec ses compteurs — SHALL s'exécuter dans une **unique transaction de lecture SQLite** : une publication concurrente ne peut pas intercaler une génération entre les étapes d'une même commande ; c'est ce qui rend tenable l'absence de mélange de générations au sein d'une lecture. Les compteurs de lecture (`maskedCount`, `visible`, `total`) restent exacts ; leur calcul est un **dénombrement sur la plage indexée de la session** — son coût dépend de la plage, pas de la fenêtre affichée — et il est couvert par les cibles du banc, pas caché. La vue SHALL porter en son sein le watermark du corpus auquel elle correspond ; toute lecture SHALL vérifier cette fraîcheur et refuser explicitement une vue absente ou périmée (motif + instruction de réparation), au lieu de rendre des données décalées sans le dire. **Limite écrite** (retour du 20/09 soir) : la fraîcheur couvre le **chemin d'ingestion documenté** — une modification hors ingestion (fichier édité sans ingestion, watermark inchangé) n'est pas détectée par la fraîcheur ; l'outil de détection est l'empreinte du corpus, pas le watermark. La vue reste **entièrement reconstruisable depuis le seul corpus** (contrat d'index jetable inchangé) ; le corpus JSONL demeure la référence et le rebuild fait foi en cas de divergence.

#### Scenario: Vue absente

- **WHEN** `sdig read <session>` est exécuté alors que la vue dérivable n'est pas construite
- **THEN** la commande échoue avec un message indiquant comment construire la vue — elle ne retombe pas silencieusement sur un parcours complet du corpus.

#### Scenario: Vue périmée

- **WHEN** la vue ne correspond plus au watermark du corpus (corpus ingéré plus récemment, vue issue d'un autre corpus)
- **THEN** les lectures refusent avec le motif de fraîcheur et l'instruction de réparation, sans rendre un mélange de générations.

#### Scenario: Fenêtre bornée

- **WHEN** une session de 100 000 messages est lue avec `--ctx 5` autour d'un message
- **THEN** seuls les messages de la fenêtre sont lus et rendus ; le coût et la mémoire de l'opération ne dépendent pas de la taille de la session.

#### Scenario: Snapshot unique pendant une publication concurrente

- **WHEN** une ingestion publie (COMMIT de la vue) pendant qu'une commande de lecture multi-étapes (hits, puis voisins, puis compteurs) s'exécute
- **THEN** la commande rend un ensemble issu d'un seul snapshot : cohérent d'un bout à l'autre, la nouvelle génération n'étant visible qu'aux lectures suivantes.

#### Scenario: Comptage sur la plage

- **WHEN** `--at` masque une large partie d'une session géante et `maskedCount` est calculé
- **THEN** le compte est exact et son coût — dénombrement de la plage masquée via l'index — est mesuré au banc et consigné, pas présenté comme borné par la fenêtre.

#### Scenario: Modification hors ingestion non détectée par la fraîcheur

- **WHEN** un shard du corpus est modifié manuellement sans ingestion (watermark inchangé)
- **THEN** la fraîcheur ne signale rien — la détection de ce type de modification appartient à l'empreinte du corpus, et la documentation le dit.

### Requirement: Opérations en mémoire bornée

Décision du 20/09 (change `scale-corpus`, contrainte d'échelle) : **aucune commande** du CLI — ingestion, indexation, lecture, preuve brute, recherche (y compris `--raw`), statut, migration — ne charge le corpus, la base source ou une archive v1 dans son intégralité en mémoire. Les parcours complets (rebuild, migration) SHALL s'exécuter en flux, par lots bornés. La lecture de la source pendant l'ingestion SHALL s'opérer en flux, sans matérialiser l'intégralité de la base. Les preuves brutes — affichage comme scan — SHALL être lues **par blocs bornés** (avec recouvrement aux frontières pour le scan) : l'empreinte mémoire ne dépend ni du nombre ni de la taille des fichiers `raw/`. L'empreinte mémoire de chaque opération SHALL être bornée indépendamment de la taille du corpus ; la borne visée est une cible de conception, vérifiée au banc synthétique et consignée.

#### Scenario: Lecture d'une session très longue

- **WHEN** `sdig read` rend une fenêtre d'une session très longue
- **THEN** l'empreinte mémoire de la commande est bornée par la fenêtre demandée, pas par la session ni le corpus.

#### Scenario: Preuve gigantesque

- **WHEN** un fichier de `raw/` fait plusieurs centaines de mégaoctets et est affiché ou scanné
- **THEN** il est lu par blocs bornés : l'empreinte mémoire ne dépend pas de sa taille.

#### Scenario: Ingestion initiale volumineuse

- **WHEN** la base source contient des millions de messages et que l'ingestion initiale est lancée
- **THEN** elle s'exécute en flux par lots et son empreinte mémoire reste bornée, indépendamment de la taille de la source.

#### Scenario: Migration en flux

- **WHEN** un corpus v1 de plusieurs gigaoctets est migré vers le layout v2
- **THEN** la migration traite les lignes en flux, sans charger le corpus v1 en mémoire.

### Requirement: Migration du corpus v1

Le passage d'un corpus v1 (flux `events.jsonl`/`sessions.jsonl` uniques) au layout v2 SHALL être possible **sans accès à la base source**, par une commande dédiée, en flux (mémoire bornée). La migration SHALL être idempotente : la relancer ne modifie rien. Elle SHALL être vérifiée : le nombre d'événements et de sessions est conservé et annoncé à l'issue ; toute incohérence (ligne illisible, session sans événement) SHALL être signalée explicitement, jamais ignorée. Les outils v2 face à un corpus v1 refusent explicitement (exigence « Schéma canonique et layout v2 ») en indiquant la marche à suivre : migrer, ou re-ingérer depuis la source.

#### Scenario: Migration vérifiée

- **WHEN** un corpus v1 est migré vers v2
- **THEN** l'ensemble des événements et sessions se retrouve en v2, les comptes annoncés correspondent aux comptes d'origine, et une seconde exécution ne modifie rien.

#### Scenario: Corpus v1 refusé

- **WHEN** une commande de lecture v2 est lancée sur un corpus v1
- **THEN** elle échoue avec la version de layout lue et la marche à suivre, sans lire ni écrire le corpus.

### Requirement: Empreinte déterministe du corpus

Le CLI SHALL exposer une empreinte déterministe du corpus : condensé par fichier (md5), agrégé sur les chemins relatifs **triés** — le résultat SHALL être identique quel que soit l'ordre de parcours du système de fichiers. Cette empreinte est l'outil des conditions d'évaluation (intégrité du corpus avant/après un passage, là où le layout v1 fournissait le md5 d'un fichier unique) **et l'outil de détection des modifications hors ingestion** — ce que la fraîcheur par watermark ne peut pas voir. Son calcul est O(taille du corpus) : il SHALL être explicite (commande ou option dédiée), jamais exécuté sur le chemin des commandes de lecture.

#### Scenario: Empreinte stable

- **WHEN** l'empreinte est calculée deux fois sur le même corpus, quel que soit l'ordre du répertoire
- **THEN** les deux valeurs sont identiques.

#### Scenario: Corpus modifié

- **WHEN** un fichier du corpus change — par ingestion ou par modification hors ingestion
- **THEN** l'empreinte change.
