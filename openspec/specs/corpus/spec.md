# Corpus canonique de sessions

## Purpose

Transformer le stockage local des sessions (opencode en v0) en corpus JSONL canonique et versionné. Précision du 16/09 (retour d'agent) : le corpus est une **archive normalisée** — il conserve la dernière version connue de chaque message (une modification remplace la ligne ; l'historique des versions reste dans la source, consultable par rebuild) — et non un journal immuable des versions. Le corpus est la donnée de référence ; les index de recherche et les statistiques sont des vues dérivées, jetables et reconstruisables. Le grain canonique est le message, pas le tour d'échange (décision du 15/09 : agréger vers le haut est trivial, découper vers le bas est impossible ; les regroupements se font à l'affichage ou à la requête).

## Requirements

### Requirement: Schéma canonique v1

Le corpus SHALL être composé de deux flux JSONL dans un même répertoire : `sessions.jsonl` (une ligne par session) et `events.jsonl` (une ligne par message). Chaque ligne SHALL porter `schemaVersion: 1`. Un événement SHALL contenir : `id`, `sessionId`, `ts` (ms epoch), `role` (`user` ou `assistant`), `text`, `model` (`providerID`, `modelID`), `agent`, `repo`, `tokens` (`in`, `out`, `reasoning`, `cacheRead`, `cacheWrite`) et `cost`. Un événement MAY porter un champ `toolCalls` — liste de `{tool, cmd, exitCode?, rawRef?}` — pour les messages contenant des appels d'outils (décision du 16/09 : liste et non champ unique, les données réelles montrant jusqu'à 34 appels par message) ; `exitCode` est omis quand la source ne l'expose pas ; `rawRef` référence la sortie brute dans `raw/` quand elle existe. Une session SHALL contenir : `id`, `schemaVersion`, `title`, `directory`, `repo`, `tsCreated`, `tsUpdated`, `cost`, `tokens`. Les lignes de chaque flux SHALL être ordonnées par (`sessionId`, `ts`, `id`) et SHALL être stables entre deux ingestions identiques.

#### Scenario: Message utilisateur simple

- **WHEN** un message `user` sans appel d'outil est ingéré
- **THEN** l'événement contient role, text, model, tokens et cost, et aucun champ `toolCall`.

#### Scenario: Message avec appels d'outils

- **WHEN** un message `assistant` contient une ou plusieurs parts de type `tool`
- **THEN** l'événement porte `toolCalls` avec, pour chaque appel, l'outil et la commande ; `exitCode` est renseigné si la source l'expose ; `rawRef` référence la sortie brute écrite dans `raw/`.

### Requirement: Parts non textuelles en v0

Décision du 16/09 (constat d'implémentation) : en v0, l'adaptateur opencode SHALL extraire les parts de type `text` (texte), `tool` (appels) et `step-finish` (tokens/cost) et SHALL ignorer les autres types (`reasoning`, `patch`, `snapshot`, `step-start`, `compaction`, `agent`, `file`). Cette sélection reste réversible : le corpus étant dérivable de la source par rebuild complet, ces parts pourront être ajoutées au schéma canonique dans une version ultérieure sans migration.

#### Scenario: Part de raisonnement ignorée

- **WHEN** un message contient une part `reasoning`
- **THEN** son texte n'entre ni dans `text` ni dans l'index de recherche, et aucune erreur n'est produite.

#### Scenario: Ordre stable

- **WHEN** le corpus est reconstruit intégralement depuis la même source
- **THEN** les deux flux JSONL sont identiques octet par octet à la construction précédente.

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

L'ingestion SHALL être incrémentale : un état interne (watermark sur `time_updated` des messages et sessions) détermine ce qui doit être relu. Ingestionner deux fois la même source SHALL produire zéro doublon et zéro divergence dans les flux de sortie. Un rebuild complet depuis zéro SHALL produire le même corpus, et SHALL rester disponible comme option de réparation.

#### Scenario: Double ingestion

- **WHEN** la commande d'ingestion est exécutée deux fois de suite sans changement de la source
- **THEN** les flux JSONL sont inchangés et aucun événement dupliqué n'apparaît.

#### Scenario: Source évolutive

- **WHEN** de nouveaux messages ont été écrits depuis la dernière ingestion
- **THEN** seuls les messages et sessions nouveaux ou modifiés sont relus et fusionnés en respectant l'ordre stable.

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
