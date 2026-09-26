# Delta corpus — add-pi-adapter

## Purpose

Étendre le corpus canonique d'une source unique (opencode.db) à un corpus fusionné multi-source : un adaptateur pi (sessions JSONL append-only sous `~/.pi/agent/sessions`), un état incrémental par source, et un marquage de provenance (`source`) sans réécriture du corpus existant. L'objectif est qu'une seule recherche couvre les sessions des deux agents ; le schéma canonique et le grain (le message) ne changent pas.

## MODIFIED Requirements

### Requirement: Schéma canonique v1

Le corpus SHALL être composé de deux flux JSONL dans un même répertoire : `sessions.jsonl` (une ligne par session) et `events.jsonl` (une ligne par message). Chaque ligne SHALL porter `schemaVersion: 1`. Un événement SHALL contenir : `id`, `sessionId`, `ts` (ms epoch), `role` (`user` ou `assistant`), `text`, `model` (`providerID`, `modelID`), `agent`, `repo`, `tokens` (`in`, `out`, `reasoning`, `cacheRead`, `cacheWrite`) et `cost`. Un événement MAY porter un champ `toolCalls` — liste de `{tool, cmd, exitCode?, rawRef?}` — pour les messages contenant des appels d'outils (décision du 16/09 : liste et non champ unique, les données réelles montrant jusqu'à 34 appels par message) ; `exitCode` est omis quand la source ne l'expose pas ; `rawRef` référence la sortie brute dans `raw/` quand elle existe. Une session SHALL contenir : `id`, `schemaVersion`, `title`, `directory`, `repo`, `tsCreated`, `tsUpdated`, `cost`, `tokens`. Les lignes de chaque flux SHALL être ordonnées par (`sessionId`, `ts`, `id`) et SHALL être stables entre deux ingestions identiques.

Toute ligne de session ou d'événement **produite par une ingestion postérieure à ce change** SHALL porter un champ `source` (chaîne courte identifiant l'adaptateur producteur, ex. `"opencode"`, `"pi"`). Une ligne du corpus existant, sans champ `source`, est lue comme issue de la source opencode et n'est pas réécrite pour seule addition du champ ; une ligne opencode modifiée ultérieurement est réécrite avec le champ — la stabilité s'apprécie pour un même ensemble de sources et les mêmes règles de sérialisation, pas entre un corpus mono-source hérité et un corpus multi-source. Un identifiant produit par un adaptateur dont l'espace d'id n'est pas partagé avec opencode (pi) SHALL être préfixé par son préfixe de source (`pi:`) sur `id` de session et `id` d'événement ; les partIds de preuve suivent la même convention de nommage **qualifiée par session** — `pi:<sessionId>:<id local>`, où `<sessionId>` est l'UUID de session pi sans préfixe (le partId étant déjà ouvert par `pi:`) : id d'appel pour un résultat rattaché (`rawRef`), id de ligne pour une exécution orpheline (sans `rawRef`, même nommage) — afin qu'aucune collision de shard ou de preuve ne soit possible entre sources ni entre sessions d'une même source ; les identifiants opencode ne sont pas modifiés.

#### Scenario: Message utilisateur simple

- **WHEN** un message `user` sans appel d'outil est ingéré
- **THEN** l'événement contient role, text, model, tokens et cost, et aucun champ `toolCall`.

#### Scenario: Message avec appels d'outils

- **WHEN** un message `assistant` contient une ou plusieurs parts de type `tool`
- **THEN** l'événement porte `toolCalls` avec, pour chaque appel, l'outil et la commande ; `exitCode` est renseigné si la source l'expose ; `rawRef` référence la sortie brute écrite dans `raw/`.

#### Scenario: Lignes de sources distinctes

- **WHEN** le corpus existant opencode est complété par une première ingestion pi
- **THEN** les nouvelles lignes portent leur champ `source`, les identifiants pi sont préfixés `pi:`, et aucune ligne opencode existante n'est réécrite ni voilée par un identifiant modifié.

#### Scenario: Ordre stable multi-source

- **WHEN** le corpus est reconstruit intégralement depuis le **même ensemble de sources**, avec les mêmes règles de sérialisation
- **THEN** les deux flux JSONL sont identiques octet par octet à la construction précédente ; comparer une reconstruction multi-source à un corpus mono-source hérité n'est pas une régression d'ordre stable.

### Requirement: Ingestion incrémentale et idempotence

L'ingestion SHALL être incrémentale : l'état interne est **par source**. Pour la source opencode, un watermark sur `time_updated` des messages et sessions détermine ce qui doit être relu. Pour une source de fichiers append-only (pi), l'état est porté par fichier (taille, horodatage) : un fichier inchangé n'est pas relu, un fichier changé est relu intégralement — aucune reprise à mi-fichier — et un fichier raccourci ou incohérent avec l'état est relu intégralement. Ingestionner deux fois la même source SHALL produire zéro doublon et zéro divergence dans les flux de sortie. Un rebuild complet depuis zéro SHALL produire le même corpus, et SHALL rester disponible comme option de réparation — cette égalité s'apprécie **depuis les mêmes sources** : une archive qui a conservé des sessions d'une source depuis disparue (fichiers supprimés, chemin re-pointé) n'est pas intégralement reconstructible depuis les seules sources restantes, et cette perte n'est pas une divergence de rebuild.

L'état d'une source enregistre le chemin de cette source : un changement de chemin (surcharge `--db`/`--pi-dir`, variable d'environnement) invalide l'état de la source concernée — relecture intégrale au prochain passage, signalée explicitement — sans toucher l'état des autres sources. L'état pi n'acquitte que les octets réellement lus : la taille enregistrée est celle du dernier octet de la dernière ligne **terminée** ; une ligne finale non terminée (sans terminateur) est ignorée sans erreur et ses octets ne sont pas acquittés — le prochain changement du fichier la relit complète. Une ligne **terminée** dont le JSON est invalide provoque un échec explicite, sans corpus partiellement écrit. L'état par fichier est mesuré après lecture : si le fichier a changé pendant la lecture, la divergence constatée au prochain passage déclenche une relecture — un octet jamais lu n'est jamais acquis.

Le delta de toutes les sources actives SHALL être publié en une seule passe du protocole de publication (marqueur, staging, renames, COMMIT de la vue, état), sans état intermédiaire partiellement publié par source. La fraîcheur de la vue est vérifiée **par source** : la vue porte, pour chaque source, un jeton de fraîcheur déterministe dérivé de son état incrémental (condensat de l'ensemble trié des clés de l'état de la source), comparé à celui de l'état publié ; une vue en retard sur une source est en retard. Un état interne de forme antérieure (watermark plat, mono-source) est interprété comme état de la source opencode et migré vers la forme multi-source au premier COMMIT, sans réingestion forcée ; le delta opencode suivant est nul si sa base est inchangée. Une vue en avance sur l'état (crash entre COMMIT et état) reste un état publié valide, ré-appliqué idempotemment, y compris pour la source pi ; `--recover` conserve l'état incrémental de chaque source et reconstruit les jetons de fraîcheur depuis le corpus tel qu'il est.

#### Scenario: Double ingestion

- **WHEN** la commande d'ingestion est exécutée deux fois de suite sans changement de la source
- **THEN** les flux JSONL sont inchangés et aucun événement dupliqué n'apparaît.

#### Scenario: Source évolutive

- **WHEN** de nouveaux messages ont été écrits depuis la dernière ingestion (source opencode : filtre watermark ; source pi : le fichier changé est relu intégralement)
- **THEN** seuls les messages et sessions nouveaux ou modifiés entrent dans la fusion, par identifiant, en respectant l'ordre stable.

#### Scenario: Fichier source append-only changé

- **WHEN** un fichier de session pi a grandi depuis la dernière ingestion
- **THEN** le fichier est relu intégralement, la fusion par identifiant ne produit aucun doublon, et l'état par fichier est mis à jour au COMMIT.

#### Scenario: État mono-source hérité

- **WHEN** un `state.json` de forme plate est présent et la base opencode est inchangée
- **THEN** il est traité comme l'état de la source opencode, migré en forme multi-source, et le delta opencode suivant est nul.

#### Scenario: Ligne finale non terminée

- **WHEN** un fichier de session est en cours d'écriture et se termine par une ligne sans terminateur
- **THEN** l'ingestion réussit sans erreur, cette ligne n'entre pas dans le corpus, ses octets ne sont pas acquittés, et elle est ingérée une fois terminée.

#### Scenario: Ligne terminée invalide

- **WHEN** un fichier source contient une ligne terminée dont le JSON est invalide
- **THEN** l'ingestion échoue explicitement sans produire de corpus partiellement écrit ; la tolérance ne couvre que la ligne finale non terminée.

#### Scenario: Chemin de source changé

- **WHEN** la source pi est re-pointée vers un autre répertoire entre deux ingestions
- **THEN** l'état pi est invalidé, la relecture est intégrale et signalée, et l'état opencode est inchangé.

#### Scenario: Fichier source supprimé

- **WHEN** un fichier de session suivi par l'état pi disparaît
- **THEN** il est retiré de l'état au COMMIT et ses shards publiés sont conservés — le corpus est une archive, la suppression n'est pas propagée ; ces shards ne sont plus reconstructibles depuis la source restante (cf. rebuild).

## ADDED Requirements

### Requirement: Adaptateur pi

L'adaptateur pi SHALL lire le répertoire des sessions pi (`~/.pi/agent/sessions` par défaut) en lecture seule stricte : jamais d'écriture, de renommage ou de déplacement dans la source ; le répertoire des sessions vivantes reste lisible pendant une ingestion. Le `cwd` d'une session SHALL venir de la ligne d'en-tête du fichier, jamais du nom du répertoire encodé.

L'adaptateur SHALL produire le même schéma canonique que l'adaptateur opencode, avec le même contrat de sortie (sessions, événements, sorties brutes, ordre groupé par session). Mapping : les lignes `message` de rôle `user` et `assistant` deviennent des événements (texte = parts `text` jointes) ; les parts de raisonnement sont ignorées (aligne la politique « parts non textuelles en v0 », réversible par rebuild) ; les parts d'appel d'outil deviennent des `toolCalls` avec outil et commande extraite des arguments. Les messages de résultat sont raccrochés selon une règle unique et déterministe : un `toolResult` par l'identifiant d'appel (`toolCallId`) quand il est présent ; un `bashExecution` uniquement à un appel d'outil `bash` antérieur **non résolu du même fichier, le plus récent dans l'ordre du fichier**. Le rattachement fournit `exitCode` quand la source l'expose et `rawRef` (`pi:<sessionId>:<toolCallId>`) vers la sortie brute dans `raw/`. Un message de résultat sans appel correspondant est une **exécution orpheline** (ex. commande directe hors appel d'agent) : sa sortie est écrite dans `raw/` sous un identifiant stable `pi:<sessionId>:<id de ligne>` — lisible par `sdig raw` et communiqué par la sortie d'ingestion, jamais par un `rawRef` inventé dans un événement — le cas étant compté et signalé ; le scan `--raw` ne couvre que les preuves référencées par des événements, les orphelines en sont donc exclues par conception. Les tokens et coûts viennent du `usage` du message ; le titre de session, absent de la source, est dérivé du premier texte utilisateur ou omis ; les sessions et messages sans métriques portent des zéros. Les lignes `compaction`, `branch_summary`, `model_change`, `thinking_level_change` et `custom*`, et le rôle `system`, sont ignorés en v0. Les branches (chaîne de parenté) sont aplaties par ordre temporel — perte documentée, pas silencieuse.

#### Scenario: Session pi vivante

- **WHEN** pi est en cours d'exécution pendant l'ingestion
- **THEN** l'ingestion en lecture seule réussit sans perturber la session active, ou échoue proprement sans produire de corpus partiellement écrit.

#### Scenario: Appel d'outil avec résultat

- **WHEN** un message assistant porte un appel d'outil et qu'un message de résultat lui correspond dans le même fichier
- **THEN** l'événement porte `toolCalls` avec `rawRef` vers la sortie brute, et `exitCode` quand la source l'expose.

#### Scenario: Exécution orpheline

- **WHEN** un `bashExecution` apparaît sans appel d'outil bash antérieur non résolu dans le même fichier
- **THEN** sa sortie est écrite dans `raw/` sous `pi:<sessionId>:<id de ligne>`, aucun `rawRef` n'est inventé dans un événement, le cas est compté et signalé, et la preuve reste lisible par `sdig raw` — mais pas par le scan `--raw`, qui ne couvre que les preuves référencées.

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
