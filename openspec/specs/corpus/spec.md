# Corpus canonique de sessions

## Purpose

Transformer le stockage local des sessions (opencode en v0) en corpus JSONL canonique et versionné. Précision du 16/09 (retour d'agent) : le corpus est une **archive normalisée** — il conserve la dernière version connue de chaque message (une modification remplace la ligne ; l'historique des versions reste dans la source, consultable par rebuild) — et non un journal immuable des versions. Le corpus est la donnée de référence ; les index de recherche et les statistiques sont des vues dérivées, jetables et reconstruisables. Le grain canonique est le message, pas le tour d'échange (décision du 15/09 : agréger vers le haut est trivial, découper vers le bas est impossible ; les regroupements se font à l'affichage ou à la requête).
## Requirements
### Requirement: Parts non textuelles en v0

Décision du 16/09 (constat d'implémentation) : en v0, l'adaptateur opencode SHALL extraire les parts de type `text` (texte), `tool` (appels) et `step-finish` (tokens/cost) et SHALL ignorer les autres types (`reasoning`, `patch`, `snapshot`, `step-start`, `compaction`, `agent`, `file`). Cette sélection reste réversible : le corpus étant dérivable de la source par rebuild complet, ces parts pourront être ajoutées au schéma canonique dans une version ultérieure sans migration.

#### Scenario: Part de raisonnement ignorée

- **WHEN** un message contient une part `reasoning`
- **THEN** son texte n'entre ni dans `text` ni dans l'index de recherche, et aucune erreur n'est produite.

#### Scenario: Ordre stable

- **WHEN** le corpus est reconstruit intégralement depuis la même source
- **THEN** chaque fichier du corpus (shards d'événements et `sessions.jsonl`) est identique octet par octet à la construction précédente.

### Requirement: Adaptateur opencode

L'adaptateur opencode SHALL lire `~/.local/share/opencode/opencode.db` en mode strictement lecture seule (URI `mode=ro`) sans jamais écrire, copier ou verrouiller durablement la base source. Il SHALL extraire : les sessions (tables `session` : id, title, directory, time_created, time_updated, cost, tokens_*) ; les messages (table `message` : role, model, agent depuis le champ `data`) ; le texte des parts de type `text` ; l'outil et la commande des parts de type `tool` ; les métriques `tokens` et `cost` des parts `step-finish` agrégées au niveau du message. Le champ `repo` SHALL être le basename de `session.directory`. Toute évolution du schéma interne d'opencode SHALL être absorbée par l'adaptateur seul, sans changement du schéma canonique.

#### Scenario: Base absente

- **WHEN** le fichier `opencode.db` n'existe pas
- **THEN** l'adaptateur échoue avec un message d'erreur explicite et n'écrit aucun fichier de corpus.

#### Scenario: Session opencode concurrente

- **WHEN** opencode est en cours d'exécution pendant l'ingestion
- **THEN** l'ingestion en lecture seule réussit sans perturber la session active, ou échoue proprement sans produire de corpus partiellement écrit.

### Requirement: Sorties d'outils hors corpus

Les sorties complètes des appels d'outils (outputs) SHALL être écrites hors du JSONL, dans un répertoire `raw/` du corpus, référencées par l'id de la part concernée. Le JSONL SHALL rester léger et diffable à l'œil. Les sorties volumineuses ne polluent donc jamais le texte cherchable ni les fichiers de corpus.

#### Scenario: Sortie volumineuse

- **WHEN** une part `tool` produit une sortie de plusieurs centaines de lignes
- **THEN** le corps va dans `raw/`, l'événement JSONL ne porte que la référence, et la taille de la ligne JSONL reste bornée.

### Requirement: Ingestion incrémentale et idempotence

L'ingestion SHALL être incrémentale : un état interne (watermark sur `time_updated` des messages et sessions) détermine ce qui doit être relu. Ingestionner deux fois la même source SHALL produire zéro doublon et zéro divergence dans les sorties. Un rebuild complet depuis zéro SHALL produire le même corpus, et SHALL rester disponible comme option de réparation.

Recentrage solo : en passe normale sur une vue saine, un delta ne SHALL pas imposer la réécriture de tous les shards. Les coûts SHALL être explicités : delta retourné par opencode, découverte/stat des fichiers Pi et relecture des fichiers Pi changés, sessions touchées, métadonnées et inventaires de sessions/fichiers. Une réparation/reconstruction reste un parcours complet explicite. Pour opencode, le filtre watermark SHALL être une clause SQL sur `time_updated`, sans matérialisation applicative des tables complètes. Le plan dépend de SQLite et des index disponibles : un scan de la source reste possible et SHALL être signalé et mesuré sur la machine cible ; aucune création d'index dans la source n'est autorisée implicitement. Ajouter un message à une session géante peut réécrire son shard : coût assumé, pas promesse O(delta).

**Protocole de publication** : un **marqueur persistant d'ingestion en cours** (fichier dédié) est posé **avant tout remplacement de fichier** et retiré en tout dernier, après l'écriture de `state.json` ; chaque fichier réécrit est d'abord préparé sous un nom temporaire ; la publication exécute les renames, puis valide la transaction de la vue dérivable — **le COMMIT de la vue est le point de publication** — puis écrit `state.json` et retire le marqueur ; les temporaires orphelins sont ramassés à la passe suivante. Conséquences contractuelles : chaque shard est publié atomiquement — jamais de shard déchiré ; entre shards, la publication est **éventuelle** (un crash pendant les renames peut laisser sur disque un mélange de générations de shards), mais **aucune commande de lecture ne consulte les shards directement** : les lectures réussies passent par la vue et rendent un **état publié cohérent**, ou refusent explicitement si sa fraîcheur ne peut être établie. Un crash entre le COMMIT et `state.json` laisse la vue en avance. Le cas opencode peut rester lisible si sa fraîcheur est établie ; une divergence de jeton pi rend la vue fusionnée indisponible jusqu'à réconciliation depuis les shards puis état cohérent, selon `add-pi-adapter`. La relance converge sans doublon ; le contrat ne promet pas de disponibilité permanente. Une preuve brute consultée pendant une publication interrompue peut être en avance sur la vue (raw publié avant le COMMIT) : transitoire documenté, **signalé dans la sortie** tant que le marqueur est présent, réparé à la passe suivante. Règle normative limitée à `sdig read … --json` : lorsque la vue est fraîche et que l'avertissement est émis, il SHALL être routé vers stderr afin que stdout reste un unique document JSON valide, sans altérer le contenu, les comptes ni la métadonnée de fidélité ; le mode terminal sans `--json` conserve le routage existant. Le marqueur ne dispense jamais d'un contrôle de fraîcheur de la vue, et cette règle ne crée aucune exigence générale pour les autres commandes. Les parcours d'archive (rebuild, empreinte, migration) sont régis par le marqueur : tant qu'il est présent, l'état n'est pas réconcilié et ils **refusent** avec la marche à suivre — un crash après le dernier rename, avant le COMMIT, ne laisse plus de fichier temporaire ni d'écart de `state.json` détectable autrement. La réconciliation est la relance de l'ingestion — idempotente, elle reconverge et retire le marqueur. À défaut de source, une **reprise explicite** (décision d'opérateur, jamais implicite) assume l'état sur disque : la vue est reconstruite depuis le corpus tel qu'il est, le watermark de `state.json` est conservé (la prochaine ingestion depuis la source convergera) — un rebuild par défaut ne transforme jamais un état non publié en référence. La passe suivante converge toujours vers le même résultat qu'une passe unique.

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
- **THEN** la sortie porte un avertissement explicite (preuve potentiellement plus récente que la vue), en plus de la preuve demandée — l'avertissement reste toujours visible, jamais supprimé.

#### Scenario: Avertissement de publication en lecture JSON

- **WHEN** `sdig read <session> --json` réussit sur une vue fraîche alors que le marqueur d'ingestion en cours est présent
- **THEN** stdout reste un unique document JSON valide (aucun préfixe ni décor d'avertissement), le contenu, les comptes et la métadonnée de fidélité pi restent inchangés par rapport à la même lecture sans marqueur, et l'avertissement SHALL être routé vers stderr, toujours visible ; en mode terminal sans `--json`, le routage existant de l'avertissement est conservé. Le marqueur ne dispense pas du contrôle de fraîcheur de la vue, et ce scénario ne couvre que `sdig read … --json`.

### Requirement: Indépendance de la source

Le schéma canonique SHALL être indépendant de toute source particulière. Tout futur adaptateur (Claude Code, historique zsh, reflog git, exports Agora) SHALL produire exactement le même schéma et SHALL passer la même suite de tests contractuels que l'adaptateur opencode. Le cœur du projet (indexation, recherche, statistiques) SHALL ne jamais lire une source directement : uniquement le corpus.

#### Scenario: Nouvel adaptateur

- **WHEN** un adaptateur claude-code est ajouté
- **THEN** aucun changement du cœur n'est requis au-delà de l'enregistrement de l'adaptateur, et les tests contractuels passent sans adaptation.

### Requirement: Emplacement et confidentialité

Le corpus SHALL vivre par défaut sous `~/.local/share/session-dig/`, chemin surchargeable par option ou variable d'environnement. Le corpus contient l'historique réel des sessions : il SHALL rester local, ne jamais être publié, et figurer dans `.gitignore` du dépôt. Seuls des fixtures synthétiques committés servent aux tests.

#### Scenario: Chemin par défaut

- **WHEN** aucune option de chemin n'est fournie
- **THEN** le corpus est lu/écrit sous `~/.local/share/session-dig/` sans aucune écriture hors de ce répertoire.

### Requirement: Adaptateur pi

L'adaptateur pi SHALL lire le répertoire des sessions pi (`~/.pi/agent/sessions` par défaut) en lecture seule stricte : jamais d'écriture, de renommage ou de déplacement dans la source ; le répertoire des sessions vivantes reste lisible pendant une ingestion. Le `cwd` d'une session SHALL venir de la ligne d'en-tête du fichier, jamais du nom du répertoire encodé.

L'adaptateur SHALL produire le même schéma canonique que l'adaptateur opencode, avec le même contrat de sortie (sessions, événements, sorties brutes, ordre groupé par session). Mapping : les lignes `message` de rôle `user` et `assistant` deviennent des événements (texte = parts `text` jointes) ; les parts de raisonnement sont ignorées (aligne la politique « parts non textuelles en v0 », réversible par rebuild) ; les parts d'appel d'outil deviennent des `toolCalls` avec outil et commande extraite des arguments. Les messages de résultat sont raccrochés selon une règle unique et déterministe : un `toolResult` par l'identifiant d'appel (`toolCallId`) quand il est présent ; un `bashExecution` uniquement à un appel d'outil `bash` antérieur **non résolu du même fichier, le plus récent dans l'ordre du fichier**. Le rattachement fournit `exitCode` quand la source l'expose et `rawRef` (`pi:<sessionId>:<toolCallId>`) vers la sortie brute dans `raw/`. Un message de résultat sans appel correspondant est une **exécution orpheline** (ex. commande directe hors appel d'agent) : sa sortie est écrite dans `raw/` sous un identifiant stable `pi:<sessionId>:<id de ligne>` — lisible par `sdig raw` et communiqué par la sortie d'ingestion, jamais par un `rawRef` inventé dans un événement — le cas étant compté et signalé ; le scan `--raw` ne couvre que les preuves référencées par des événements, les orphelines en sont donc exclues par conception. Les tokens et coûts viennent du `usage` du message ; le titre de session est le `name` non vide de la dernière ligne `session_info` du fichier dans l'ordre des lignes ; à défaut, la première ligne du premier texte utilisateur, limitée à 60 caractères ; à défaut, `null` — une modification du titre met à jour la session canonique et sa ligne de titre synthétique dans la vue. Les sessions et messages sans métriques portent des zéros. Les lignes `context_edit`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change` et `custom*`, ainsi que le rôle `system`, sont ignorés en v0 ; `session_info` ne fournit que le titre. Toute ligne de type non reconnu est ignorée et comptée par type dans le bilan d'ingestion, sans divulguer son contenu ; cette tolérance ne s'applique pas au JSON invalide d'une ligne terminée. L'adaptateur v0 archive les messages enregistrés sans appliquer les remplacements `context_edit` au contexte effectif : cette perte sémantique est documentée et ne peut être corrigée qu'en faisant évoluer l'adaptateur puis en reconstruisant depuis la source conservée. Les branches (chaîne de parenté) sont aplaties par ordre temporel — perte documentée, pas silencieuse.

#### Scenario: Session pi vivante

- **WHEN** pi est en cours d'exécution pendant l'ingestion
- **THEN** l'ingestion en lecture seule réussit sans perturber la session active, ou échoue proprement sans produire de corpus partiellement écrit.

#### Scenario: Appel d'outil avec résultat

- **WHEN** un message assistant porte un appel d'outil et qu'un message de résultat lui correspond dans le même fichier
- **THEN** l'événement porte `toolCalls` avec `rawRef` vers la sortie brute, et `exitCode` quand la source l'expose.

#### Scenario: Exécution orpheline

- **WHEN** un `bashExecution` apparaît sans appel d'outil bash antérieur non résolu dans le même fichier
- **THEN** sa sortie disponible est écrite dans `raw/` sous `pi:<sessionId>:<id de ligne>` (l'absence d'`output` n'impose pas une preuve vide), aucun `rawRef` n'est inventé dans un événement, le cas est compté et signalé, et la preuve reste lisible par `sdig raw` — mais pas par le scan `--raw`, qui ne couvre que les preuves référencées.

#### Scenario: Titre renommé

- **WHEN** un fichier pi contient plusieurs lignes `session_info` avec `name` non vide
- **THEN** la dernière détermine le titre canonique et la ligne synthétique de titre, qui porte la `source` de la session ; sans nom non vide, le repli utilisateur puis `null` s'applique.

#### Scenario: Édition de contexte ignorée

- **WHEN** une ligne `context_edit` cible un message déjà enregistré
- **THEN** elle ne crée aucun événement et ne modifie pas le message canonique en v0 ; elle est comptée, et la limitation sémantique est documentée.

#### Scenario: Type de ligne inconnu

- **WHEN** une ligne JSON valide porte un type non reconnu
- **THEN** elle est ignorée, comptée sous ce type, et son contenu n'apparaît pas dans le bilan ; une ligne terminée au JSON invalide demeure une erreur.

#### Scenario: Appels multiples du même outil

- **WHEN** plusieurs appels bash non résolus précèdent un `bashExecution` dans le même fichier
- **THEN** le rattachement désigne le plus récent ; les autres restent non résolus (rattrapés si leur résultat vient plus loin, sinon comptés comme appels sans preuve, jamais de rattachement ambigu).

#### Scenario: Répertoire source absent

- **WHEN** la sélection est explicite (`--source pi`) et le répertoire des sessions n'existe pas
- **THEN** l'adaptateur échoue avec un message explicite et aucun corpus n'est écrit ; en sélection `all`, il n'est pas invoqué : la source est signalée et ignorée (cf. Registre de sources).

#### Scenario: Parties ignorées

- **WHEN** une session contient des lignes `compaction` ou des parts de raisonnement
- **THEN** elles n'entrent ni dans `text` ni dans l'index, et aucune erreur n'est produite.

### Requirement: Registre de sources

L'ingestion SHALL connaître un registre de sources : opencode (base SQLite, surchargeable `--db`/`SESSION_DIG_DB`) et pi (répertoire de sessions, surchargeable `--pi-dir`/`SESSION_DIG_PI_DIR`). Une surcharge de source SHALL s'appliquer à sa source seule, jamais implicitement à une autre. La sélection SHALL être `all` (défaut), `opencode` ou `pi`. En sélection `all`, une source par défaut absente est signalée explicitement dans la sortie et ignorée — ce n'est pas une erreur ; si **aucune** source n'est présente, l'ingestion échoue explicitement (rien à ingérer). Une source sélectionnée explicitement et absente est une erreur et le corpus n'est pas écrit. `sdig status` SHALL afficher l'état incrémental par source (watermark epoch pour opencode, fichiers suivis et dernier jeton de fraîcheur pour pi).

#### Scenario: Environnement mono-source

- **WHEN** seul le répertoire pi existe et aucune sélection explicite n'est fournie
- **THEN** la source pi est ingérée, l'absence de la base opencode est signalée, et aucune erreur n'est produite.

#### Scenario: Source explicite absente

- **WHEN** `--source pi` est demandé et le répertoire pi est absent
- **THEN** l'ingestion échoue explicitement sans écriture de corpus.

#### Scenario: Aucune source présente

- **WHEN** la sélection est `all` et aucune source du registre n'existe
- **THEN** l'ingestion échoue explicitement — elle ne produit pas un corpus vide silencieux.

#### Scenario: État par source

- **WHEN** `sdig status` est exécuté après une ingestion multi-source
- **THEN** chaque source est présentée avec son état incrémental (epoch pour opencode, fichiers suivis pour pi).

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
