# Delta mcp — add-mcp-chrono

## MODIFIED Requirements

### Requirement: Catalogue d'outils et fermeture

Le catalogue SHALL être fermé : `sdig_search`, `sdig_read` et `sdig_status`. `sdig_raw` SHALL **être absent** de la première livraison ; son ajout ultérieur reste éventuel et soumis à un nouvel accord explicite, avec les garde-fous déjà spécifiés dans le design (confinement `raw/`, validation `partId` avant dérivation de chemin, partIds orphelins pi refusés, `unvetted: true`). Aucune ingestion, réindexation, commande shell, lecture de fichier arbitraire ou resource/prompt donnant accès au système de fichiers SHALL être exposée. Les fichiers du jeu d'évaluation SHALL ne pas être lus par ces outils ; cela ne promet pas de retirer des extraits éventuellement déjà copiés dans l'archive.

`sdig_search` SHALL rendre des hits avec extraits, identifiants complets et références exploitables vers `sdig_read`, non le texte intégral paginé des messages. Les hits synthétiques de titre SHALL être distingués des messages et référencer la session. Les filtres et le scoring SHALL réutiliser la logique existante. `sdig_read` SHALL fournir la lecture de session, la fragmentation du texte et l'ancrage ; la lecture complète paginée par fragments SHALL donner accès à l'intégralité du contenu de la vue choisie, y compris un message long : aucun mode SHALL présenter un contenu tronqué comme complet. `sdig_status` SHALL fournir compteurs et état sans chemin local ; par source, il SHALL distinguer disponibilité actuelle de la source configurée, présence d'un état ingéré et watermark publié ; une source absente mais déjà archivée SHALL être signalée sans erreur ni effacement d'état, et les sessions archivées de cette source restent recherchables ; les compteurs globaux exacts connus SHALL être rendus, les compteurs par source seulement s'ils sont disponibles, sinon `null`.

`sdig_search` SHALL accepter un paramètre `source` de sémantique identique au filtre CLI de recherche, filtrant les messages comme les titres synthétiques ; un nom de source inconnu SHALL rendre zéro hit. `agent` SHALL filtrer le champ exact — les sessions pi v0 portent `null`, un filtre non nul les exclut — et la description de l'outil SHALL le documenter. `session` SHALL être un préfixe littéral échappé. `sdig_search` SHALL accepter un paramètre `sort` à valeurs **fermées** `relevance` (défaut), `oldest` et `newest` ; toute autre valeur SHALL être refusée (`invalid_params`), jamais ramenée silencieusement à `relevance`. **Option `sort` absente, ou `relevance` explicite : la sélection et l'ordre de pertinence SHALL rester strictement inchangés.** En `oldest`/`newest`, la requête `query` MAY être omise (exigence « Exploration MCP sans mots-clés ») ; en `relevance`, `query` SHALL rester obligatoire. Une requête fournie mais vide, en espaces ou sans terme exploitable (stopwords, ponctuation) SHALL être refusée (`invalid_params`) et ne SHALL JAMAIS basculer silencieusement en exploration : seule l'omission PHYSIQUE de `query` active l'exploration. La recherche top-k SHALL être **bornée** (`limit` ≤ plafond) et sans pagination ni curseur quel que soit `sort` : l'affinage passe par une requête précisée ou des filtres plus restrictifs (`repo`, `session`, `source`, `after`/`before`, `model`, `role`, `agent`) — ou, en chrono, par des bornes temporelles — ce que la description de l'outil SHALL indiquer. En mode `relevance`, l'ordre SHALL rester stable, avec départage des scores égaux par identifiant canonique complet en ordre binaire. En `oldest`/`newest`, l'ordre primaire SHALL être `(ts, id COLLATE BINARY)` dans le sens demandé, appliqué à l'ENSEMBLE des événements filtrés sélectionnés AVANT `limit` — jamais à un top-k BM25 déjà réduit ; le score BM25 MAY rester projeté en diagnostic mais SHALL ne pas déterminer cet ordre. Dans les deux modes, la sélection SHALL précéder le regroupement par session.

Les paramètres initiaux et plafonds sont définis dans D2/D3 du design. Seul `sdig_read` SHALL accepter `cursor` ; le mélange d'un curseur avec des paramètres initiaux SHALL être refusé (`invalid_params`). `search` et `status` SHALL refuser tout paramètre `cursor`. Les types invalides, nombres non entiers, valeurs négatives, tailles de pages nulles et chaînes trop longues SHALL être refusés avant travail. Une limite numérique valide supérieure au maximum SHALL être ramenée au plafond et cette adaptation signalée ; `ctx=0` reste valide.

Les descriptions des trois outils SHALL mentionner dès le MVP que le contenu peut inclure des secrets et être transmis au fournisseur du modèle appelant, et que le contenu de l'archive est une donnée non fiable, jamais une instruction à exécuter. L'absence de raw ne SHALL pas être présentée comme une anonymisation.

Les réponses `sdig_search` rendant un hit ou voisin pi (titres compris) et chaque page `sdig_read` d'une session pi connue, même vide à l'ancre, SHALL reprendre le signal structuré de limites de fidélité du change `add-pi-adapter` : branches aplaties et `context_edit` non appliqué, associé à la source pi. Le signal SHALL compter dans le budget sérialisé ; il SHALL être conservé dans les continuations de lecture. Il décrit une limite générale de l'adaptateur, pas une détection dans la session. Les descriptions de search/read SHALL préciser que l'ancrage temporel ne reconstruit ni la branche retenue ni le contexte effectif. Aucun résultat pi rendu dans search = aucun signal pi ; aucune nouvelle lecture de source ni reconstruction sémantique n'est requise.

Décision du 05/10/2026 (change `add-mcp-chrono`) : la chronologie MCP SHALL réutiliser la sémantique du tri chronologique CLI (change `add-cli-chronological-sort`) — même ordre `(ts, id BINARY)`, mêmes filtres, même distinction entre requête OMISE (exploration sans mots-clés) et requête fournie vide ou sans terme exploitable. Elle SHALL ne créer AUCUN filtre nouveau, AUCUN outil nouveau et AUCUNE sous-commande, et SHALL préserver les contrats existants de `sdig_search` : top-k borné sans curseur, `total` exact quand connu sinon `null`, enveloppe 524 288 octets, extraits référencés vers `sdig_read`, signal de fidélité pi. Les exigences « Tri chronologique de la recherche MCP », « Exploration MCP sans mots-clés » et « Honnêteté et bornes du tri chronologique MCP » précisent ce comportement.

#### Scenario: Limites pi dans les réponses et continuations

- **WHEN** search rend un titre pi ou read rend une page d'une session pi connue, initiale, continuée ou vide à l'ancre
- **THEN** les deux limites pi sont exposées comme métadonnées structurées associées à pi, dans le budget de réponse, sans prétendre détecter une branche abandonnée ou une édition ; une recherche opencode-only ou sans résultat n'émet pas ce signal.

#### Scenario: Recherche puis lecture

- **WHEN** une recherche trouve un message long
- **THEN** le hit présente un extrait identifié comme tel et sa référence session/message ; l'appelant peut obtenir le texte complet par `sdig_read`, sans pagination de ce texte dans `sdig_search`.

#### Scenario: Filtre par source

- **WHEN** une recherche porte `source=pi` sur un corpus mixte
- **THEN** elle ne rend aucun hit ni titre d'une autre source, avec la sémantique du CLI.

#### Scenario: Catalogue sans raw

- **WHEN** le service démarre avec sa configuration par défaut
- **THEN** seuls `sdig_search`, `sdig_read` et `sdig_status` sont exposés ; l'outillage de preuves brutes (`sdig_raw`) reste un ajout futur explicite (lot durcissement), pas un outil masqué.

#### Scenario: Demande d'écriture ou de fichier arbitraire

- **WHEN** un appelant demande une ingestion, une commande ou une lecture de chemin libre
- **THEN** aucun outil ne permet cette opération et la demande est refusée explicitement.

#### Scenario: Limite supérieure dépassée

- **WHEN** une limite numérique valide dépasse son plafond
- **THEN** le plafond est appliqué et la réponse indique l'ajustement.

#### Scenario: Paramètre invalide

- **WHEN** une taille de page est négative, nulle ou non entière, ou un paramètre a un type invalide
- **THEN** le travail ne démarre pas et la réponse porte `invalid_params`.

#### Scenario: Tri chronologique demandé

- **WHEN** `sdig_search` est appelé avec `sort: oldest` (ou `newest`) et une `query` fournie
- **THEN** les hits sont sélectionnés sur l'ensemble des matches filtrés puis ordonnés chronologiquement de façon globale, `limit` s'applique après l'ordre, et le score BM25 reste présent comme diagnostic sans déterminer cet ordre.

#### Scenario: Valeur de tri inconnue

- **WHEN** `sort` porte une valeur hors de `relevance|oldest|newest`
- **THEN** l'appel est refusé (`invalid_params`) sans travail, sans retomber silencieusement sur `relevance`.

#### Scenario: Requête absente avec tri de pertinence

- **WHEN** `sdig_search` est appelé sans `query` avec `sort` absent ou `sort: relevance`
- **THEN** l'appel est refusé (`invalid_params`), sans requête `'*'` inventée ni déversement de l'archive ; en `oldest`/`newest`, l'omission physique de `query` donne lieu à l'exploration sans mots-clés.

#### Scenario: Requête fournie vide ou sans terme exploitable

- **WHEN** `sdig_search` est appelé avec `sort: oldest` et une `query` fournie mais vide, en espaces ou réduite à des stopwords/ponctuation
- **THEN** l'appel est refusé (`invalid_params`) — normalisation existante — et le mode d'exploration n'est PAS activé silencieusement : seule l'omission physique de `query` l'active.

## ADDED Requirements

### Requirement: Tri chronologique de la recherche MCP

`sdig_search` SHALL offrir `sort: relevance|oldest|newest`, `relevance` par défaut. En `oldest`/`newest`, la sélection SHALL porter sur l'ENSEMBLE des événements qui matchent la requête (si fournie) et les filtres, puis l'ordre et `limit` SHALL s'appliquer — jamais un tri d'un top-k BM25 déjà réduit. La normalisation de requête (retrait des stopwords fr+en, tokenizer unicode, disjonction pondérée OR, jetons pointés traités comme phrases) et les filtres exacts (`repo`, `session`, `source`, `after`, `before`, `model`, `role`, `agent`) SHALL être IDENTIQUES à ceux du mode `relevance` : aucun filtre nouveau n'est introduit. L'ordre SHALL être, en `oldest`, `(ts ASC, id COLLATE BINARY ASC)`, et en `newest`, `(ts DESC, id COLLATE BINARY DESC)` : comparaison sur l'epoch millisecondes entier (`ts` INTEGER, `ts = 0` valide), jamais sur une chaîne de date ; les `ts` égaux SHALL être départagés par l'id canonique qualifié (ex. `pi:<sessionId>:<id local>`) en ordre binaire, garantissant un ordre global déterministe entre sources et entre exécutions. `limit` SHALL s'appliquer APRÈS l'ordre, avec le même plafond qu'en `relevance` (≤ 50). En chrono AVEC requête, le score BM25 MAY rester projeté en `score` **diagnostique numérique**, sans jamais déterminer l'ordre. La recherche chronologique SHALL rester un top-k borné SANS pagination ni curseur : l'affinage passe par des bornes temporelles (`after`/`before`) ou des filtres plus restrictifs. `sort` absent, ou `sort: relevance`, SHALL laisser le contrat de la recherche de pertinence strictement inchangé, requête obligatoire comprise.

#### Scenario: Premier match moins pertinent

- **WHEN** l'archive contient plus de N matches et que le plus ancien des matches n'appartient pas au top-N BM25
- **THEN** `sort: oldest` avec `limit: N` le rend en tête : la sélection a lieu sur tous les matches filtrés, pas sur le top-N de pertinence.

#### Scenario: Égalité de ts entre sources

- **WHEN** deux événements de deux sources distinctes portent le même `ts`
- **THEN** leur ordre est départagé par l'id canonique en ordre binaire, de façon stable et identique à chaque exécution.

#### Scenario: Filtre avant tri et limite

- **WHEN** des filtres (`repo`, `after`, `model`, `role`, `source`…) réduisent la population
- **THEN** le tri chronologique et `limit` s'appliquent à cette population filtrée, jamais à l'archive entière.

#### Scenario: Horodatage à l'epoch

- **WHEN** un événement porte `ts = 0`
- **THEN** il est ordonné sur sa valeur numérique (avant tout `ts` positif en `oldest`), sans être traité comme absent.

#### Scenario: Score diagnostique en chrono avec requête

- **WHEN** `sort: oldest` est employé avec une `query` fournie
- **THEN** chaque hit porte un `score` numérique calculé (BM25 diagnostique), sans que ce score détermine l'ordre chronologique.

### Requirement: Exploration MCP sans mots-clés

`sdig_search` SHALL permettre, en `sort: oldest|newest` UNIQUEMENT, d'omettre physiquement `query` (exploration sans mots-clés). Sans `query`, la sélection SHALL lire le sous-ensemble CANONIQUE de la vue courante : l'intersection `role ∈ {user, assistant}` ∩ filtre `role` éventuel. Une ligne `role: title` ou une valeur de `role` inconnue SHALL produire ZÉRO hit : les lignes de titre sont un artefact d'index, jamais des messages, et ne SHALL pas être incluses sans mots-clés. Les événements à texte vide ou à commandes seules SHALL être inclus, contrairement à la recherche FTS qui exige un terme exploitable. Les filtres exacts (`repo`, `session`, `source`, `after`, `before`, `model`, `role`, `agent`) SHALL s'appliquer inchangés. Le filtre `source` SHALL porter sur la PROVENANCE ARCHIVÉE, pas sur la disponibilité actuelle : une source inconnue rend zéro hit, mais une source archivée dont la base d'origine a disparu du disque reste cherchable, sans aucune lecture de la source d'origine. La métadonnée de modèle absente SHALL rester `null` explicite, jamais inventée ; sans `model`, tous les assistants sont candidats, y compris ceux sans modèle, et `model: M` filtre par sous-chaîne comme en `relevance`. En exploration, `score` SHALL être `null` (BM25 non calculé, aucun faux score). `sort: relevance` sans `query` SHALL être refusé (`invalid_params`) ; une requête fournie vide, en espaces ou sans terme exploitable SHALL être refusée, jamais transformée en exploration.

#### Scenario: Première trace avec modèle

- **WHEN** `sdig_search` reçoit `{ sort: "oldest", role: "assistant", model: "M", limit: 1 }` sans `query`
- **THEN** il retourne le plus ancien événement assistant portant le modèle M dans le sous-ensemble filtré de la vue courante, avec son `ts` minimal, son `id` qualifié et `score: null`.

#### Scenario: Modèle absent jamais inventé

- **WHEN** aucun `model` n'est fourni en exploration et qu'un assistant rendu n'a pas de métadonnée de modèle
- **THEN** son champ `model` vaut `null` explicite, jamais une valeur inventée ; `model: M` filtre par sous-chaîne et exclut les autres modèles.

#### Scenario: Titre exclu sans mots-clés

- **WHEN** l'exploration est utilisée sans `query`
- **THEN** aucune ligne `role: title` n'est retournée ; une requête implicite `'*'` n'est jamais construite, et chaque hit reste un événement borné par `limit`.

#### Scenario: Texte vide ou commande seule inclus

- **WHEN** un événement canonique n'a pas de texte mais porte des commandes (`toolCalls[].cmd`)
- **THEN** il est candidat en exploration sans mots-clés, alors que la recherche FTS l'exclurait faute de terme.

#### Scenario: Source archivée absente du disque

- **WHEN** la base d'origine d'une source a disparu du disque mais ses événements sont archivés, et qu'un tri chronologique filtre sur cette source sans `query`
- **THEN** les événements archivés restent cherchables et rendus (le filtre porte sur la provenance archivée, pas sur la disponibilité actuelle), sans aucune lecture de la source d'origine ; une source inconnue rend toujours zéro hit.

#### Scenario: Rôle titre ou inconnu sans mots-clés

- **WHEN** l'exploration est appelée avec `role: "title"` ou un rôle inconnu
- **THEN** zéro hit est rendu (intersection canonique), sans jamais inclure une ligne de titre ni élargir le sous-ensemble.

### Requirement: Honnêteté et bornes du tri chronologique MCP

Le tri chronologique SHALL préserver le contrat borné de `sdig_search` sans l'élargir : top-k borné (`limit` ≤ 50), AUCUN curseur et AUCUNE pagination, `truncated` explicite pour toute coupure, et une enveloppe MCP sérialisée ≤ 524 288 octets, extraits référencés vers `sdig_read` compris. `total` SHALL être exact quand le nombre de matches filtrés de la sélection est inférieur à `limit` (sélection exhaustive), et `null` sinon, jamais estimé ; il porte sur la SÉLECTION, pas sur les hits effectivement rendus : une réduction d'enveloppe éventuelle est signalée dans `truncated.dimensions` (dimension `hits`) et ne modifie ni ne fausse `total` — une troncature par `limit` ou par enveloppe SHALL ne pas être présentée comme une exhaustivité. `count` et `topK` conservent leur sémantique. En `oldest`/`newest`, le tableau `hits` SHALL porter l'ordre chronologique global : le regroupement par session (`groups`) SHALL n'être qu'un index de session et ne SHALL pas être interprété comme l'ordre. `score` SHALL rester numérique en `relevance` (inchangé) et en chrono AVEC requête (diagnostic BM25) ; il SHALL être `null` UNIQUEMENT en exploration sans `query` — adaptation explicitement documentée du domaine du champ, jamais un score inventé. Le signal structuré de fidélité pi SHALL être conservé pour toute donnée pi rendue (titres compris) ; une recherche sans donnée pi rendue n'émet aucun signal. Aucun outil nouveau, aucun `sdig_raw`, aucun changement du curseur de `sdig_read` : ce change n'ajoute QUE l'option `sort` de `sdig_search`. Le tri SHALL réutiliser la vue courante et le snapshot de lecture seule existants, sans mutation implicite (aucune réparation, réindexation ni lecture de source) ; une vue absente ou périmée SHALL produire le refus existant (`view_unavailable`, aucune erreur interne). La sélection chronologique MAY scanner tous les matches filtrés côté SQL : c'est un coût honnête, sans garantir que la réponse tienne sous aucun délai donné.

#### Scenario: Total exact ou inconnu

- **WHEN** `sort: oldest` sélectionne moins de matches filtrés que `limit`
- **THEN** `total` égale le nombre exact de matches filtrés de la sélection ; lorsque ce nombre atteint `limit`, `total` vaut `null`, sans estimation ni prétention d'exhaustivité ; si l'enveloppe réduit ensuite les hits rendus, la coupure est signalée dans `truncated.dimensions` (dimension `hits`) et `total` reste celui de la sélection.

#### Scenario: Aucun curseur de recherche

- **WHEN** `sdig_search` est appelé en `oldest`/`newest`, ou avec un paramètre `cursor`
- **THEN** la réponse n'émet aucun `nextCursor` et un `cursor` soumis à search est refusé (`invalid_params`), quel que soit `sort`.

#### Scenario: Vue indisponible

- **WHEN** la vue est absente ou périmée au moment d'un tri chronologique
- **THEN** la réponse porte `view_unavailable` sans indexation, réparation ni lecture de source déclenchée implicitement.

#### Scenario: Fidélité pi conservée

- **WHEN** un tri chronologique rend un hit ou un titre pi
- **THEN** le signal structuré de fidélité pi est présent dans le budget de réponse ; une recherche sans donnée pi rendue ne l'émet pas.

#### Scenario: Score null seulement en exploration

- **WHEN** une recherche chronologique est faite AVEC requête, puis SANS requête
- **THEN** le premier cas porte un `score` numérique (diagnostic) et le second `score: null` ; le mode `relevance` conserve un `score` numérique inchangé.
