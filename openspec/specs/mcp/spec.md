# mcp Specification

## Purpose
TBD - created by archiving change add-mcp-server. Update Purpose after archive.
## Requirements
### Requirement: Architecture et transport

Le service SHALL utiliser Node/ESM et le SDK MCP officiel avec Streamable HTTP. Le paquet et sa version SHALL être vérifiés et épinglés dans un change d'implémentation séparé. Le service SHALL écouter exclusivement sur `127.0.0.1:18767`, refuser toute autre adresse configurée, ne faire aucun appel réseau sortant (modèle, proxy, API, télémétrie) et ne jamais écrire de **données** dans le corpus, l'index ou la base source. Les ouvertures SQLite SHALL être en lecture seule, sans prétendre garantir une absence absolue de contention avec le CLI. **Exception étroite — décision utilisateur du 01/10/2026** : le service PEUT créer ou laisser les annexes natives de coordination SQLite de la vue `index.db-wal`/`index.db-shm` ; aucune donnée du corpus, de la vue ou de la base source n'est écrite, aucune suppression/cleanup manuel sous concurrence, `immutable=1` et l'ignorance d'un WAL vivant SHALL rester exclus, et si le stockage ne permet pas cette coordination le service SHALL refuser de façon bornée (`view_unavailable`) sans autre écriture.

Le service SHALL valider `Host` selon les formes loopback et port attendus. Un `Origin` absent est permis ; un `Origin` présent SHALL être une origine loopback valide. Les valeurs externes ou malformées, dont `Origin: null`, SHALL être refusées avant tout travail. Ces contrôles SHALL ne pas être présentés comme une authentification ni comme une protection contre tous les clients ou pages d'origine locale. Un token statique optionnel, s'il est configuré, SHALL être exigé sur chaque requête et comparé en temps constant. Sans token, la documentation SHALL indiquer l'absence d'authentification des clients locaux.

Le lancement SHALL être manuel et documenté ; aucun deuxième transport ni installation automatique n'est prévu. L'ajout au manifeste Termux reste une décision propriétaire distincte, pas une conséquence de cette spec.

#### Scenario: Écoute confinée

- **WHEN** une configuration demande une adresse autre que `127.0.0.1`
- **THEN** le démarrage est refusé explicitement.

#### Scenario: Host ou Origin refusé

- **WHEN** une requête porte un Host inattendu ou un Origin externe ou malformé
- **THEN** elle est refusée avant traitement (`forbidden_host`), même si sa connexion TCP vient du loopback.

#### Scenario: Client sans Origin

- **WHEN** un client MCP non navigateur omet Origin et satisfait les contrôles Host et de token éventuellement configuré
- **THEN** l'absence d'Origin ne suffit pas à refuser la requête.

#### Scenario: Aucun egress ni écriture

- **WHEN** un outil est appelé
- **THEN** le service travaille exclusivement sur les données locales en lecture seule, sans appel externe ni modification des **données** du corpus, de l'index ou de la base source ; seules les annexes natives SQLite `index.db-wal`/`index.db-shm` de la vue peuvent être créées ou laissées pour la coordination.

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

### Requirement: Sorties bornées et compteurs honnêtes

Chaque réponse SHALL respecter les plafonds par appel : 50 hits par recherche, 200 messages distincts, **20 000 points de code par page** (agrégat texte + commandes rendus) et **524 288 octets de réponse MCP sérialisée UTF-8**, enveloppe et curseurs compris. Le contexte SHALL être limité à 5 voisins par côté dans search et 50 par côté dans read, sous le budget global. L'assemblage de search SHALL donner la priorité aux hits, puis remplir le budget restant avec les voisins de contexte, coupures et comptes explicites par dimension. Une réduction du nombre de hits sous `limit` pour tenir le budget SHALL être signalée, sans curseur de recherche. Dans read, chaque page non finale SHALL avancer. Un élément dont la représentation minimale excède seule le budget total SHALL produire une erreur bornée explicite, pas une suite de pages sans progrès.

Toute coupure SHALL être explicite dans `truncated`. Les quantités retenues SHALL être exactes ; les totaux SHALL être exacts quand connus, sinon `null`, jamais estimés. Le service SHALL ne pas être tenu de calculer un total exhaustif seulement pour renseigner ce champ. Un total inconnu SHALL ne pas être interprété comme une absence de résultats.

Quand un contenu de **read** a une suite dans la vue choisie (messages ou fragments), la réponse SHALL porter `truncated.nextCursor` ; sinon, ce champ SHALL être absent. **Search ne SHALL jamais émettre de `nextCursor` dans le MVP**, même si d'autres correspondances existent ; la sélection top-k et toute réduction par budget SHALL être explicites, sans prétendre à l'exhaustivité. Une coupure d'extrait de recherche SHALL fournir une référence vers `read`, sans exiger de curseur pour ce texte. `full` SHALL respecter les plafonds et, s'il coupe un message plus long, SHALL le signaler (suite accessible par curseur dans `sdig_read`) — jamais présenter la partie rendue comme le texte complet. Les comptes de lecture disponibles (`maskedCount`, `visible`, `total`) conservent la sémantique CLI.

#### Scenario: Total de recherche inconnu

- **WHEN** une recherche retourne ses meilleurs hits sans calcul exhaustif du nombre total de correspondances
- **THEN** le nombre rendu est exact, le total est `null` et aucun curseur n'est fourni ; la réponse indique la sélection bornée et ne prétend pas que le total égale le nombre rendu.

#### Scenario: Budget global atteint

- **WHEN** une réponse atteindrait le budget global, métadonnées comprises
- **THEN** le contenu est réduit avant sérialisation finale et la coupure est signalée ; dans read, la continuation reprend les éléments non rendus ; dans search, les références vers read et l'affinage de la recherche restent disponibles, sans curseur.

#### Scenario: Full atteint le plafond

- **WHEN** `full` est demandé sur un message plus long que le plafond
- **THEN** le fragment est borné, la coupure est signalée comme telle (le fragment n'est pas présenté comme le texte complet), et sa suite est accessible par curseur dans `sdig_read`.

#### Scenario: Dernière page sans faux curseur

- **WHEN** une page de read couvre le dernier fragment du dernier message de la vue choisie
- **THEN** aucune valeur `nextCursor` n'est émise : l'appelant ne se retrouve pas avec une page suivante vide déguisée en suite possible.

#### Scenario: Élément minimal hors budget

- **WHEN** la représentation minimale d'un élément excède seule le budget de réponse
- **THEN** l'appel retourne une erreur bornée, sans curseur conduisant à des pages sans progrès.

### Requirement: Continuation de lecture complète

La continuation est réservée à `sdig_read` et SHALL préserver la requête initiale, son ordre, son ancre et sa fenêtre. Search ne SHALL pas implémenter de pagination dans le MVP ; ses extraits et voisins renvoient à read pour leur texte intégral.

`sdig_read` SHALL permettre de récupérer **tous les messages, textes et commandes d'appels de la vue choisie**, par pages et fragments identifiés (message, offset, fin de message) — c'est le chemin d'accès au contenu complet. Les unités d'offset et l'encodage SHALL être documentés. Les fragments SHALL se recoller sans trou, doublon ou caractère perdu ; ces tests de recollement (accents, emoji, coupure par budget global) font partie de la v1. Les **commandes d'appels** SHALL être fragmentées de la même façon bornée qu'un texte : une commande coupée SHALL être signalée comme telle (`toolCallFragments`) et SHALL ne jamais être présentée comme entière dans `toolCalls` ; `complete` SHALL n'être vrai que lorsque le texte ET tous les appels sont complets. L'ajout de `toolCallFragments`, `textComplete`, `toolCallsComplete` et `callIndex` est additif ; aucune borne SHALL être réduite.

Le curseur SHALL être opaque, inerte, validé et lié à l'outil, à la requête initiale et à l'état lu. Un curseur altéré ou étranger SHALL être refusé (`invalid_cursor`) ; un changement de génération SHALL donner `stale_cursor`, sans suite mélangeant des états. Un curseur perdu SHALL être refusé explicitement, jamais traité comme une nouvelle requête. L'identité binaire des curseurs n'est pas exigée. Si un état de curseur est conservé côté serveur, ses bornes mémoire et sa durée de vie SHALL être documentées. L'implémentation SHALL paginer à la requête et extraire les fragments avant construction de la réponse, sans matérialiser une session entière pour la découper.

#### Scenario: Recherche au-delà du plafond

- **WHEN** une recherche a plus de correspondances que `limit`
- **THEN** elle retourne au plus `limit` hits sélectionnés dans un ordre stable, signale la sélection bornée et ne rend aucun curseur ; la description indique comment affiner. Un appel search avec `cursor` est refusé `invalid_params`.

#### Scenario: Recollement de messages Unicode

- **WHEN** une vue contient des messages dépassant les plafonds, avec accents et emoji
- **THEN** la continuation conserve ancre et fenêtre, chaque fragment est identifiable (identifiant de message, offset, fin de message) et le recollement restitue les textes exacts sans message masqué temporellement ni caractère perdu.

#### Scenario: Lecture complète par fragments

- **WHEN** une vue contient 300 messages dont un de 60 000 caractères
- **THEN** la totalité des 300 messages et des 60 000 caractères est accessible par des appels `sdig_read` successifs (fenêtres puis fragments), sans trou ni duplication — aucun contenu de la vue n'est rendu inaccessible par les plafonds.

#### Scenario: Génération modifiée

- **WHEN** le corpus ou l'index change entre deux pages
- **THEN** le curseur est refusé (`stale_cursor`) et l'appelant est invité à relancer la requête initiale.

### Requirement: Ancrage temporel et lecture bornée

`sdig_read` SHALL appeler la sémantique partagée du CLI : UTC, validation calendaire stricte, ancre vide refusée, instant exact inclus, masquage avant fenêtrage. La réponse SHALL exposer l'ancre résolue, `maskedCount`, `visible` et `total`. La continuation SHALL conserver cette vue. Le service SHALL ne détecter ni qualifier les mutations d'état. Une nouvelle lecture sans ancre reste possible : le filtre temporel n'est pas un contrôle d'accès.

#### Scenario: Vue temporelle continuée

- **WHEN** une lecture avec ancre nécessite plusieurs pages
- **THEN** toutes les pages conservent la même ancre et fenêtre, sans restituer les messages postérieurs masqués.

#### Scenario: Ancre invalide

- **WHEN** l'ancre est vide, impossible, inconnue ou issue d'une autre session
- **THEN** une erreur `invalid_anchor` est retournée, jamais une session entière non bornée par défaut.

#### Scenario: Vue vide

- **WHEN** aucun message n'est visible à l'ancre ou la fenêtre demandée est postérieure
- **THEN** le résultat expose le motif de la vue vide et l'ancre, sans ambiguïté avec une archive absente.

### Requirement: Concurrence mono-travail et durée honnête

Le service SHALL traiter **un seul appel d'outil à la fois**. À l'admission, si le créneau est occupé, l'appel SHALL recevoir `busy`, sans file applicative supplémentaire ; s'il est libre, l'appel peut démarrer. Les tampons du transport ne sont pas une file de travail applicative : une requête arrivée pendant un calcul synchrone peut être traitée après sa fin puis admise. Aucune réactivité immédiate ni détection rétrospective de saturation n'est promise. Un durcissement ultérieur (concurrence >1, timeout applicatif avec arrêt observable) reste soumis à accord, hors MVP.

Les limites de taille (exigence « Sorties bornées ») SHALL borner le volume des réponses, **pas la durée du calcul** : un `LIMIT` SQL ne fixe aucune borne de temps, et le contrat SHALL ne pas prétendre le contraire. Le service SHALL présenter honnêtement ses limites (aucun marqueur d'annulation simulé) : aucun code `timeout` tant qu'un arrêt réel n'est pas documenté et prouvé sur la pile réelle (appels natifs SQLite compris) ; pas de `Promise.race` présentée comme annulation. Un travail lent peut retarder tout le serveur — le contrat SHALL le dire explicitement, plutôt que de promettre une réactivité garantie. Un timeout ou une déconnexion du client ne SHALL pas être présenté comme la preuve d'un arrêt du calcul serveur. L'arrêt et la reprise du serveur SHALL rester manuels et documentés, avec fermeture des connexions à l'arrêt normal et sans travail de fond détaché survivant ; les seules traces persistantes tolérées après arrêt sont les annexes natives SQLite `index.db-wal`/`index.db-shm` de la vue (décision utilisateur du 01/10/2026). Le MCP en lecture seule ne SHALL jamais lancer une réparation ou une réconciliation ; un état d'ingestion interrompue relève du CLI.

Les erreurs applicatives SHALL avoir des codes stables (`unknown_session`, `invalid_anchor`, `invalid_cursor`, `stale_cursor`, `invalid_params`, `view_unavailable`, `forbidden_host`, `busy`, `internal`), sans copie de contenu d'archive, requête libre ou secret. Une vue absente ou périmée SHALL donner `view_unavailable`, motif technique distingué sans chemin local ; une requête sans terme exploitable SHALL être `invalid_params`, jamais `internal`. Les identifiants repris dans les messages SHALL être validés. Les erreurs de protocole MCP restent distinctes.

#### Scenario: Saturation mono-travail

- **WHEN** le gestionnaire d'admission traite un appel alors que le créneau de travail est encore occupé
- **THEN** il répond `busy`, sans mise en file applicative ni travail concurrent ; si le calcul synchrone précédent a empêché cette admission jusqu'à sa fin, l'appel peut être admis une fois le créneau libre.

#### Scenario: Pas de faux timeout

- **WHEN** un calcul de lecture dure plus longtemps que le délai attendu par le client
- **THEN** aucun timeout applicatif garanti ni annulation n'est revendiqué par le MVP ; une déconnexion client ne libère pas prématurément le créneau d'un travail toujours actif.

#### Scenario: Requête lente pendant un calcul

- **WHEN** un calcul de lecture s'étend dans la durée
- **THEN** le serveur peut être momentanément non réactif pour les autres requêtes ; cette limite est documentée, l'opérateur peut redémarrer manuellement le serveur, et les données restent cohérentes (lecture seule).

#### Scenario: Vue indisponible

- **WHEN** la vue est absente ou périmée au moment d'un appel
- **THEN** la réponse porte `view_unavailable` avec son motif, sans chemin local ni contenu privé.

### Requirement: Confidentialité de l'archive

Les journaux par défaut SHALL être limités à une liste autorisée : nom d'outil, limites/fenêtres/offsets numériques, identifiants techniques validés, compteurs connus, durée, code d'erreur. Ils SHALL exclure query, filtres libres, curseurs, tokens, messages et sorties brutes. Un mode debug de contenu SHALL nécessiter une activation explicite annoncée ; aucun secret d'authentification SHALL être journalisé.

Toute lecture, y compris un message ordinaire, peut contenir des secrets ; la documentation SHALL le dire et ne SHALL promettre aucun filtrage ou anonymisation. La borne de taille n'est pas une garantie de confidentialité. La documentation SHALL rappeler que le service n'appelle aucun modèle mais que le client peut transmettre les réponses au fournisseur du modèle appelant.

#### Scenario: Journaux sans contenu

- **WHEN** un appel contient une citation privée dans query ou un filtre
- **THEN** ce texte n'apparaît pas dans les journaux par défaut, même en cas d'erreur.

#### Scenario: Secret dans un message ordinaire

- **WHEN** un message lu contient un secret
- **THEN** le service ne promet pas de le supprimer ; le contenu n'est pas journalisé par défaut et la documentation avertit de son exposition possible au modèle appelant.

### Requirement: Fraîcheur, déterminisme des données et schéma stable

Les résultats SHALL porter les informations disponibles de fraîcheur **par source** (watermarks opencode, jeton de fraîcheur pi et nombre de fichiers suivis si connu), avec l'horodatage de l'index et la version du schéma à titre de diagnostic, absentes ou `null` si indisponibles ; l'horodatage de l'index SHALL ne pas être présenté comme une identité de génération. Une continuation SHALL être liée à l'identité de la génération publiée de la vue et à ses watermarks par source ; le service SHALL ne pas émettre de curseur prétendument sûr sans pouvoir identifier l'état lu. Une vue en avance sur `state.json` SHALL être interprétée selon le protocole de publication, pas par comparaison d'ordre du jeton pi. Un changement détecté pendant la lecture SHALL invalider la page plutôt que mélanger des générations.

**Disponibilité honnête (divergence pi)** : si le jeton de fraîcheur pi de la vue ne correspond plus à celui de l'état publié (divergence vue/état), les lectures de la vue fusionnée SHALL répondre `view_unavailable` temporaire — jusqu'à réconciliation par le CLI selon le protocole corpus/pi (reconstruction depuis les shards puis état cohérent) — au lieu de prétendre que la lecture est toujours disponible ; une réponse de lecture réussie SHALL être **cohérente** (un seul snapshot), mais le contrat SHALL ne pas promettre une disponibilité permanente des lectures.

À corpus/index et paramètres identiques, les données d'un appel terminé avec succès et leur ordre SHALL être identiques. Cette exigence ne porte ni sur la représentation des curseurs, ni sur les identifiants de requête ou durées, ni sur les erreurs de saturation. Les curseurs peuvent différer s'ils permettent la même continuation. Ajouter un champ est compatible ; supprimer/renommer un champ ou réduire une borne SHALL nécessiter une évolution de spec. Une donnée inconnue SHALL être absente ou `null`, jamais inventée.

#### Scenario: Rejeu des données

- **WHEN** le même appel réussit deux fois sur le même corpus/index
- **THEN** les données et l'ordre sont identiques ; d'éventuels curseurs différents permettent la même suite.

#### Scenario: Fraîcheur modifiée

- **WHEN** deux lectures encadrent une ingestion ou réindexation
- **THEN** l'état modifié est détectable et les anciens curseurs ne servent pas de suite incohérente.

#### Scenario: Vue en avance sur l'état, fraîcheur établie

- **WHEN** la vue a été publiée (COMMIT), `state.json` n'est pas encore écrit et le protocole permet néanmoins d'établir sa fraîcheur (cas opencode sans divergence pi)
- **THEN** la lecture peut servir le dernier état publié cohérent ; en cas de divergence pi, le scénario suivant s'applique, sans garantie de disponibilité continue.

#### Scenario: Divergence jeton pi

- **WHEN** le jeton de fraîcheur pi de la vue diffère de celui de l'état publié
- **THEN** les lectures de la vue fusionnée répondent `view_unavailable` temporaire, avec le motif et la marche à suivre, au lieu de servir des données dont la fraîcheur n'est pas établie ; la lecture redevient disponible après réconciliation.

#### Scenario: Donnée inconnue

- **WHEN** un total de recherche ou une autre donnée n'est pas disponible
- **THEN** le champ est absent ou `null` selon son contrat, jamais estimé ni remplacé par zéro.

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

