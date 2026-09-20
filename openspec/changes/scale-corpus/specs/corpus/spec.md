# Delta corpus — scale-corpus

## RENAMED Requirements

- FROM: `### Requirement: Schéma canonique v1`
- TO: `### Requirement: Schéma canonique et layout v2`

## MODIFIED Requirements

### Requirement: Schéma canonique et layout v2

Le corpus SHALL être composé d'enregistrements canoniques **inchangés depuis la v1** : un événement par message, portant `id`, `sessionId`, `ts` (ms epoch), `role` (`user` ou `assistant`), `text`, `model` (`providerID`, `modelID`), `agent`, `repo`, `tokens` (`in`, `out`, `reasoning`, `cacheRead`, `cacheWrite`) et `cost`. Un événement MAY porter un champ `toolCalls` — liste de `{tool, cmd, exitCode?, rawRef?}` — pour les messages contenant des appels d'outils (décision du 16/09 : liste et non champ unique, les données réelles montrant jusqu'à 34 appels par message) ; `exitCode` est omis quand la source ne l'expose pas ; `rawRef` référence la sortie brute dans `raw/` quand elle existe. Une session SHALL contenir : `id`, `schemaVersion`, `title`, `directory`, `repo`, `tsCreated`, `tsUpdated`, `cost`, `tokens`. Chaque ligne SHALL porter `schemaVersion: 1` : le schéma des enregistrements ne change pas avec ce change.

Décision du 20/09 (change `scale-corpus`, contrainte d'échelle : corpus 20-100× plus lourd au minimum, base source PC de 4 Go constatée) : le **layout des fichiers** passe en v2 pour tenir cette échelle. Les événements vivent dans un shard par session : `events/<p>/<sessionId>.jsonl` (`<p>` = deux premiers caractères de l'id de session), une ligne par événement, ordonnés par (`ts`, `id`), stables entre deux ingestions identiques. Les métadonnées de sessions vivent dans `sessions.jsonl` (une ligne par session, ordonnées par `id`, stables). Les sorties brutes vivent dans `raw/<p>/<partId>.txt` (`<p>` = deux premiers caractères de l'id de part). `state.json` SHALL porter un champ `layoutVersion`. Tout outil SHALL refuser explicitement un corpus dont le `layoutVersion` diffère de celui qu'il comprend, en nommant la version lue et la version attendue — jamais de lecture ou d'écriture implicite d'un layout inconnu. Ré-ingestionner ou reconstruire depuis la même source SHALL produire le même ensemble de fichiers, chaque fichier identique octet par octet.

#### Scenario: Message utilisateur simple

- **WHEN** un message `user` sans appel d'outil est ingéré
- **THEN** l'événement contient role, text, model, tokens et cost, et aucun champ `toolCall`.

#### Scenario: Message avec appels d'outils

- **WHEN** un message `assistant` contient une ou plusieurs parts de type `tool`
- **THEN** l'événement porte `toolCalls` avec, pour chaque appel, l'outil et la commande ; `exitCode` est renseigné si la source l'expose ; `rawRef` référence la sortie brute écrite dans `raw/`.

#### Scenario: Sharding par session

- **WHEN** un corpus v2 contient les événements de plusieurs sessions
- **THEN** chaque session a exactement un shard `events/<p>/<sessionId>.jsonl`, ordonné par (`ts`, `id`), et aucune ligne d'événement n'existe ailleurs.

#### Scenario: Reconstruction identique

- **WHEN** le corpus est reconstruit intégralement depuis la même source
- **THEN** l'ensemble des fichiers est identique et chaque fichier (shards d'événements, `sessions.jsonl`) est identique octet par octet à la construction précédente.

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

Décision du 20/09 (change `scale-corpus`, contrainte d'échelle) : le coût d'une passe incrémentale SHALL dépendre du **delta lu depuis la source, pas de la taille du corpus** : seuls les shards des sessions nouvelles ou modifiées sont réécrits (coût borné par la taille de session), `sessions.jsonl` reste le seul coût O(#sessions), et la vue dérivable est mise à jour dans la même passe (pas de réindexation séparée). L'ingestion SHALL prendre un verrou consultatif sur le corpus pour empêcher deux ingestions concurrentes ; les lecteurs ne verrouillent pas (échanges atomiques par fichier). Les écritures sont atomiques par fichier et `state.json` est écrit en dernier : une interruption laisse le corpus lisible et cohérent (certains shards avancés, watermark ancien), et la passe suivante converge vers le même résultat qu'une passe unique — jamais un corpus déchiré.

#### Scenario: Double ingestion

- **WHEN** la commande d'ingestion est exécutée deux fois de suite sans changement de la source
- **THEN** les fichiers du corpus sont inchangés et aucun événement dupliqué n'apparaît.

#### Scenario: Source évolutive

- **WHEN** de nouveaux messages ont été écrits depuis la dernière ingestion
- **THEN** seuls les messages et sessions nouveaux ou modifiés sont relus et fusionnés en respectant l'ordre stable ; seuls les shards des sessions touchées sont réécrits, les autres fichiers ne sont ni lus ni réécrits.

#### Scenario: Ingestions concurrentes

- **WHEN** deux ingestions sont lancées simultanément sur le même corpus
- **THEN** le verrou fait attendre ou échouer proprement la seconde ; aucune écriture entrelacée ne peut produire un fichier de corpus corrompu.

#### Scenario: Interruption puis convergence

- **WHEN** une ingestion est interrompue avant l'écriture de `state.json`
- **THEN** le corpus reste lisible, et l'ingestion suivante converge vers le même résultat qu'une passe unique, sans doublon ni divergence.

## ADDED Requirements

### Requirement: Vue dérivable en chemin de lecture

Décision du 20/09 (change `scale-corpus`) : la vue dérivable SQLite — l'index, aujourd'hui dédié à la recherche — devient le **chemin de lecture unique** des données structurées, pour le CLI comme pour toute façade future (MCP). Elle SHALL contenir l'intégralité des enregistrements canoniques (JSON intégral par événement) et les métadonnées de sessions, avec un accès ordonné par (`sessionId`, `ts`, `id`). Les fenêtres de lecture (`--around`, `--ctx`, `--tail`, `--at`) et les voisins de recherche SHALL s'y exécuter comme des requêtes bornées : leur coût et leur empreinte mémoire dépendent de la fenêtre demandée, pas de la taille du corpus ni de la session. La vue SHALL porter le watermark du corpus auquel elle correspond ; toute lecture SHALL vérifier cette fraîcheur et refuser explicitement une vue absente ou périmée (motif + instruction de réparation), au lieu de rendre des données décalées sans le dire. La vue reste **entièrement reconstruisable depuis le seul corpus** (contrat d'index jetable inchangé) ; le corpus JSONL demeure la référence et le rebuild fait foi en cas de divergence.

#### Scenario: Vue absente

- **WHEN** `sdig read <session>` est exécuté alors que la vue dérivable n'est pas construite
- **THEN** la commande échoue avec un message indiquant comment construire la vue — elle ne retombe pas silencieusement sur un parcours complet du corpus.

#### Scenario: Vue périmée

- **WHEN** la vue ne correspond plus au watermark du corpus (corpus modifié hors ingestion, vue issue d'un autre corpus)
- **THEN** les lectures refusent avec le motif de fraîcheur et l'instruction de réparation, sans rendre un mélange de générations.

#### Scenario: Fenêtre bornée

- **WHEN** une session de 100 000 messages est lue avec `--ctx 5` autour d'un message
- **THEN** seuls les messages de la fenêtre sont lus et rendus ; le coût et la mémoire de l'opération ne dépendent pas de la taille de la session.

### Requirement: Opérations en mémoire bornée

Décision du 20/09 (change `scale-corpus`, contrainte d'échelle) : **aucune commande** du CLI — ingestion, indexation, lecture, preuve brute, recherche (y compris `--raw`), statut, migration — ne charge le corpus, la base source ou une archive v1 dans son intégralité en mémoire. Les parcours complets (rebuild, migration) SHALL s'exécuter en flux, par lots bornés. La lecture de la source pendant l'ingestion SHALL également s'opérer en flux, sans matérialiser l'intégralité de la base. L'empreinte mémoire de chaque opération SHALL être bornée indépendamment de la taille du corpus ; la borne visée est une cible de conception, vérifiée au banc synthétique et consignée.

#### Scenario: Lecture d'une session très longue

- **WHEN** `sdig read` rend une fenêtre d'une session très longue
- **THEN** l'empreinte mémoire de la commande est bornée par la fenêtre demandée, pas par la session ni le corpus.

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

Le CLI SHALL exposer une empreinte déterministe du corpus : condensé par fichier (md5), agrégé sur les chemins relatifs **triés** — le résultat SHALL être identique quel que soit l'ordre de parcours du système de fichiers. Cette empreinte est l'outil des conditions d'évaluation (intégrité du corpus avant/après un passage, là où le layout v1 fournissait le md5 d'un fichier unique). Son calcul est O(taille du corpus) : il SHALL être explicite (commande ou option dédiée), jamais exécuté sur le chemin des commandes de lecture.

#### Scenario: Empreinte stable

- **WHEN** l'empreinte est calculée deux fois sur le même corpus, quel que soit l'ordre du répertoire
- **THEN** les deux valeurs sont identiques.

#### Scenario: Corpus modifié

- **WHEN** un fichier du corpus change (shard, métadonnées, preuve)
- **THEN** l'empreinte change.
