# Delta corpus — scale-corpus

## RENAMED Requirements

- FROM: `### Requirement: Schéma canonique v1`
- TO: `### Requirement: Schéma canonique et layout v2`

## MODIFIED Requirements

### Requirement: Schéma canonique et layout v2

Le corpus SHALL être composé d'enregistrements canoniques **inchangés depuis la v1** : un événement par message, portant `id`, `sessionId`, `ts` (ms epoch), `role` (`user` ou `assistant`), `text`, `model` (`providerID`, `modelID`), `agent`, `repo`, `tokens` (`in`, `out`, `reasoning`, `cacheRead`, `cacheWrite`) et `cost`. Un événement MAY porter un champ `toolCalls` — liste de `{tool, cmd, exitCode?, rawRef?}` — pour les messages contenant des appels d'outils (décision du 16/09 : liste et non champ unique, les données réelles montrant jusqu'à 34 appels par message) ; `exitCode` est omis quand la source ne l'expose pas ; `rawRef` référence la sortie brute dans `raw/` quand elle existe. Une session SHALL contenir : `id`, `schemaVersion`, `title`, `directory`, `repo`, `tsCreated`, `tsUpdated`, `cost`, `tokens`. Chaque ligne SHALL porter `schemaVersion: 1` : le schéma des enregistrements ne change pas avec ce change.

Décision du 20/09 (change `scale-corpus`, contrainte d'échelle : corpus 20-100× plus lourd au minimum, base source PC annoncée à 4 Go à l'époque, non revérifiée lors du recentrage solo) : le **layout des fichiers** passe en v2 pour tenir cette échelle. Les événements vivent dans un shard par session : `events/<p>/<sessionId>.jsonl` (une ligne par événement, ordonnés par (`ts`, `id`), stables entre deux ingestions identiques). Les métadonnées de sessions vivent dans `sessions.jsonl` (une ligne par session, ordonnées par `id`, stables). Les sorties brutes vivent dans `raw/<p>/<partId>.txt`. **`<p>` est le préfixe de répartition** : deux premiers caractères hexadécimaux d'un condensat déterministe de l'identifiant (condensat épinglé à l'implémentation). Retour du 20/09 soir : les identifiants partagent un préfixe constant (`ses_`, `prt_`) — un préfixe tiré des premiers caractères de l'id concentrerait la totalité des fichiers dans un seul répertoire ; le condensat répartit uniformément tout en restant déterministe (une reconstruction identique produit les mêmes chemins). `state.json` SHALL porter un champ `layoutVersion`. Tout outil SHALL refuser explicitement un corpus dont le `layoutVersion` diffère de celui qu'il comprend, en nommant la version lue et la version attendue — jamais de lecture ou d'écriture implicite d'un layout inconnu. Ré-ingestionner ou reconstruire depuis la même source SHALL produire le même ensemble de fichiers, chaque fichier identique octet par octet.

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

Recentrage solo : en passe normale sur une vue saine, un delta ne SHALL pas imposer la réécriture de tous les shards. Les coûts SHALL être explicités : delta retourné par opencode, découverte/stat des fichiers Pi et relecture des fichiers Pi changés, sessions touchées, métadonnées et inventaires de sessions/fichiers. Une réparation/reconstruction reste un parcours complet explicite. Pour opencode, le filtre watermark SHALL être une clause SQL sur `time_updated`, sans matérialisation applicative des tables complètes. Le plan dépend de SQLite et des index disponibles : un scan de la source reste possible et SHALL être signalé et mesuré sur la machine cible ; aucune création d'index dans la source n'est autorisée implicitement. Ajouter un message à une session géante peut réécrire son shard : coût assumé, pas promesse O(delta).

**Protocole de publication** : un **marqueur persistant d'ingestion en cours** (fichier dédié) est posé **avant tout remplacement de fichier** et retiré en tout dernier, après l'écriture de `state.json` ; chaque fichier réécrit est d'abord préparé sous un nom temporaire ; la publication exécute les renames, puis valide la transaction de la vue dérivable — **le COMMIT de la vue est le point de publication** — puis écrit `state.json` et retire le marqueur ; les temporaires orphelins sont ramassés à la passe suivante. Conséquences contractuelles : chaque shard est publié atomiquement — jamais de shard déchiré ; entre shards, la publication est **éventuelle** (un crash pendant les renames peut laisser sur disque un mélange de générations de shards), mais **aucune commande de lecture ne consulte les shards directement** : les lectures réussies passent par la vue et rendent un **état publié cohérent**, ou refusent explicitement si sa fraîcheur ne peut être établie. Un crash entre le COMMIT et `state.json` laisse la vue en avance. Le cas opencode peut rester lisible si sa fraîcheur est établie ; une divergence de jeton pi rend la vue fusionnée indisponible jusqu'à réconciliation depuis les shards puis état cohérent, selon `add-pi-adapter`. La relance converge sans doublon ; le contrat ne promet pas de disponibilité permanente. Une preuve brute consultée pendant une publication interrompue peut être en avance sur la vue (raw publié avant le COMMIT) : transitoire documenté, **signalé dans la sortie** tant que le marqueur est présent, réparé à la passe suivante. Les parcours d'archive (rebuild, empreinte, migration) sont régis par le marqueur : tant qu'il est présent, l'état n'est pas réconcilié et ils **refusent** avec la marche à suivre — un crash après le dernier rename, avant le COMMIT, ne laisse plus de fichier temporaire ni d'écart de `state.json` détectable autrement. La réconciliation est la relance de l'ingestion — idempotente, elle reconverge et retire le marqueur. À défaut de source, une **reprise explicite** (décision d'opérateur, jamais implicite) assume l'état sur disque : la vue est reconstruite depuis le corpus tel qu'il est, le watermark de `state.json` est conservé (la prochaine ingestion depuis la source convergera) — un rebuild par défaut ne transforme jamais un état non publié en référence. La passe suivante converge toujours vers le même résultat qu'une passe unique.

**Exclusion d'écrivains (contrat, pas mécanisme)** : au plus **un écrivain** (ingestion, index/rebuild, migration, réparation) SHALL être actif sur le corpus. Toute mutation concurrente SHALL échouer proprement, avec motif et marche à suivre, sans entrelacement. Les parcours d'archive, y compris l'empreinte **en lecture seule**, SHALL être protégés contre une mutation pendant toute leur durée ; un contrôle préalable isolé ne suffit pas. Une exclusion commune suffit pour l'usage solo. Le mécanisme n'est pas imposé ; il SHALL être validé par des tests multi-processus ciblés. Pour wx/PID, cela inclut reprise/release simultanées, propriétaire mort, verrou vide/illisible et identité ambiguë (dont recyclage de PID) : le refus conservateur avec intervention explicite est permis, jamais la reprise hasardeuse d'un verrou vivant. L'implémentation actuelle reste partielle. Les lecteurs de la vue SQLite n'ont pas à prendre ce verrou ; leur cohérence repose sur snapshot et fraîcheur ou refus explicite.

#### Scenario: Double ingestion

- **WHEN** la commande d'ingestion est exécutée deux fois de suite sans changement de la source
- **THEN** les fichiers du corpus sont inchangés et aucun événement dupliqué n'apparaît.

#### Scenario: Source évolutive

- **WHEN** de nouveaux messages ont été écrits depuis la dernière ingestion
- **THEN** pour opencode, seuls les messages et sessions sélectionnés par le watermark sont retournés à l'adaptateur ; le coût du plan SQL, éventuellement un scan, est signalé. Pour Pi, les fichiers changés sont relus intégralement. En passe normale, seuls les shards des sessions touchées sont fusionnés/réécrits ; métadonnées et inventaires peuvent parcourir toutes les sessions, sans relecture globale des événements.

#### Scenario: Ingestions concurrentes

- **WHEN** deux ingestions sont lancées simultanément sur le même corpus
- **THEN** la seconde échoue proprement (erreur explicite, jamais un second écrivain actif ni une attente indéterminée) ; aucune écriture entrelacée ne peut produire un fichier de corpus corrompu.

#### Scenario: Interruption avant le point de publication

- **WHEN** une ingestion est interrompue avant le COMMIT de la vue (pendant le staging ou les renames)
- **THEN** une lecture réussie rend le dernier état publié sur un snapshot cohérent ; si la vue manque ou sa fraîcheur n'est pas établie, elle refuse explicitement. Les temporaires sont ignorés par les lectures puis ramassés à la relance, qui converge.

#### Scenario: Interruption après le point de publication

- **WHEN** une ingestion est interrompue entre le COMMIT de la vue et l'écriture de `state.json`
- **THEN** le nouvel état n'est servi que si sa fraîcheur est établie ; une divergence pi entraîne un refus temporaire de la vue fusionnée. La relance réconcilie selon le protocole de chaque source et met l'état à jour sans doublon.

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

Décision du 20/09 (change `scale-corpus`) : la vue dérivable SQLite — l'index, aujourd'hui dédié à la recherche — devient le **chemin de lecture unique** des données structurées, pour le CLI comme pour toute façade future (MCP). Elle SHALL contenir l'intégralité des enregistrements canoniques (JSON intégral par événement) et les métadonnées de sessions, avec un accès ordonné par (`sessionId`, `ts`, `id`). Les fenêtres de lecture (`--around`, `--ctx`, `--tail`, `--at`) et les voisins de recherche SHALL s'y exécuter comme des requêtes bornées : les événements matérialisés sont limités à la fenêtre demandée, avec un accès indexé par clé. Cela ne garantit pas une durée indépendante de la taille de l'index ; les compteurs ont le coût distinct décrit ci-dessous. Toutes les requêtes d'une même commande de lecture — recherche avec ses voisins, lecture avec ses compteurs — SHALL s'exécuter dans une **unique transaction de lecture SQLite** : une publication concurrente ne peut pas intercaler une génération entre les étapes d'une même commande ; c'est ce qui rend tenable l'absence de mélange de générations au sein d'une lecture. Les compteurs de lecture (`maskedCount`, `visible`, `total`) restent exacts ; leur calcul est un **dénombrement sur la plage indexée de la session** — son coût dépend de la plage, pas de la fenêtre affichée — et il est relevé sur PC puis au banc si nécessaire, pas caché. La vue SHALL porter en son sein le watermark du corpus auquel elle correspond ; toute lecture SHALL vérifier cette fraîcheur et refuser explicitement une vue absente ou périmée (motif + instruction de réparation), au lieu de rendre des données décalées sans le dire. **Limite écrite** (retour du 20/09 soir) : la fraîcheur couvre le **chemin d'ingestion documenté** — une modification hors ingestion (fichier édité sans ingestion, watermark inchangé) n'est pas détectée par la fraîcheur ; l'outil de détection est l'empreinte du corpus, pas le watermark. La vue reste **entièrement reconstruisable depuis le seul corpus** (contrat d'index jetable inchangé) ; le corpus JSONL demeure la référence. Le rebuild ordinaire refuse toutefois une publication non réconciliée : appliquer le protocole de reprise, jamais transformer silencieusement un état interrompu en référence.

#### Scenario: Vue absente

- **WHEN** `sdig read <session>` est exécuté alors que la vue dérivable n'est pas construite
- **THEN** la commande échoue avec un message indiquant comment construire la vue — elle ne retombe pas silencieusement sur un parcours complet du corpus.

#### Scenario: Vue périmée

- **WHEN** la vue ne correspond plus au watermark du corpus (corpus ingéré plus récemment, vue issue d'un autre corpus)
- **THEN** les lectures refusent avec le motif de fraîcheur et l'instruction de réparation, sans rendre un mélange de générations.

#### Scenario: Fenêtre bornée

- **WHEN** une session de 100 000 messages est lue avec `--ctx 5` autour d'un message
- **THEN** seuls les événements de la fenêtre sont matérialisés pour le rendu, sans charger la session entière ; les accès d'index et éventuels comptages de plage ne sont pas présentés comme un coût constant.

#### Scenario: Snapshot unique pendant une publication concurrente

- **WHEN** une ingestion publie (COMMIT de la vue) pendant qu'une commande de lecture multi-étapes (hits, puis voisins, puis compteurs) s'exécute
- **THEN** toute réponse réussie provient d'un seul snapshot ; si la fraîcheur ne peut plus être établie, l'appel refuse explicitement plutôt que mélanger des générations.

#### Scenario: Comptage sur la plage

- **WHEN** `--at` masque une large partie d'une session géante et `maskedCount` est calculé
- **THEN** le compte est exact et son coût — dénombrement de la plage masquée via l'index — est relevé sur PC, puis au banc si nécessaire, et consigné, pas présenté comme borné par la fenêtre.

#### Scenario: Modification hors ingestion non détectée par la fraîcheur

- **WHEN** un shard du corpus est modifié manuellement sans ingestion (watermark inchangé)
- **THEN** la fraîcheur ne signale rien — la détection de ce type de modification appartient à l'empreinte du corpus, et la documentation le dit.

### Requirement: Opérations en mémoire bornée

Décision du 20/09 (change `scale-corpus`, contrainte d'échelle) : **aucune** des commandes du CLI — ingestion, indexation, lecture, preuve brute, recherche (y compris `--raw`), statut, migration — ne SHALL matérialiser le corpus, une archive v1 ou la source **globalement** en mémoire sur ses chemins usuels. Les parcours complets (rebuild, migration) SHALL s'exécuter en flux, par lots bornés. Les preuves brutes — affichage comme scan — SHALL être lues **par blocs bornés** (avec recouvrement aux frontières pour le scan) : la mémoire ne dépend pas de la taille d'un fichier `raw/`.

**Coûts assumés à la demande de recentrage solo** : un fichier Pi changé est relu intégralement ; le delta d'une session, les sessions touchées et les listes de staging peuvent rester en mémoire. Métadonnées et inventaires peuvent dépendre de l'ensemble des sessions/fichiers. Ce n'est **pas** une garantie universelle de mémoire indépendante du corpus. Ces coûts SHALL être documentés et évalués sur PC ; tout blocage sur le volume réellement visé doit être corrigé avant validation du jalon. Toute limite appliquée SHALL être explicite, jamais une coupure silencieuse présentée comme complète. Pas de quotas arbitraires imposés par cette spec. La cible <512 Mo au banc 500k reste conditionnelle au lot C, pas un prérequis universel.

#### Scenario: Lecture d'une session très longue

- **WHEN** `sdig read` rend une fenêtre d'une session très longue
- **THEN** l'empreinte mémoire de la commande est bornée par la fenêtre demandée, pas par la session ni le corpus.

#### Scenario: Preuve gigantesque

- **WHEN** un fichier de `raw/` fait plusieurs centaines de mégaoctets et est affiché ou scanné
- **THEN** il est lu par blocs bornés : l'empreinte mémoire ne dépend pas de sa taille.

#### Scenario: Ingestion initiale volumineuse

- **WHEN** la base source contient des millions de messages et que l'ingestion initiale est lancée
- **THEN** les événements de la base sont traités par lots, sans matérialisation globale ; la mémoire des lots, des sessions touchées et des structures de suivi est mesurée, sans promesse d'indépendance vis-à-vis du nombre de sessions.

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
