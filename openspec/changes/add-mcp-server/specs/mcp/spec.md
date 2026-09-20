# Delta mcp — add-mcp-server

## Purpose

Exposer l'archive de sessions (`sdig`) à des agents — Agora, opencode, harnais d'évaluation — sous forme de **serveur MCP en lecture seule**, sans détour par le shell et sans dupliquer la logique de recherche. Le service est une **façade locale** au-dessus des capacités `corpus` et `search` : il ne fait aucun appel modèle, n'écrit jamais dans le corpus et n'expose rien hors de la machine. L'enjeu principal est le confinement : l'archive est privée, le dépôt est public, et les sorties d'outils brutes ne sont pas triées.

## ADDED Requirements

### Requirement: Architecture et transport

Le service SHALL être un serveur MCP implémenté dans le dépôt (`src/mcp/`), en Node/ESM, utilisant le SDK MCP TypeScript officiel avec le transport **Streamable HTTP**. Il SHALL écouter sur **`127.0.0.1:18767`** en loopback exclusif et SHALL refuser toute configuration d'écoute non-loopback (y compris `0.0.0.0`). Il SHALL n'effectuer **aucun appel réseau sortant** : ni fournisseur de modèle, ni proxy, ni API. Il SHALL ouvrir le corpus et l'index en **lecture seule** et SHALL ne jamais écrire dans le corpus, l'index ou la base source. La version du SDK SHALL être épinglée à l'implémentation, après vérification de la version publiée.

Le bind loopback SHALL ne pas être présenté comme une authentification. Le service SHALL valider l'en-tête `Host` (seules les formes loopback attendues sont acceptées) et SHALL refuser toute requête portant un en-tête `Origin` qui n'est pas une origine loopback, afin de se protéger du rebinding DNS et des appels depuis une page web locale. Quand un token statique est configuré, il SHALL être exigé sur chaque requête et comparé en temps constant ; quand aucun token n'est configuré, la documentation SHALL dire que la seule barrière est le loopback.

Le service SHALL pouvoir être supervisé comme les autres services Debian (manifeste Termux, journal `~/.agora/log/`), mais l'ajout au manifeste reste une décision explicite du propriétaire.

#### Scenario: Écoute confinée

- **WHEN** le service démarre
- **THEN** il n'écoute que sur l'interface loopback et une configuration demandant une autre interface est refusée au démarrage, avec un message explicite.

#### Scenario: Requête hors loopback logique

- **WHEN** une requête arrive avec un `Host` non loopback ou un `Origin` externe
- **THEN** elle est refusée sans traitement (code `forbidden_host`), même si la connexion TCP vient bien de la boucle locale.

#### Scenario: Aucun egress

- **WHEN** n'importe quel outil est appelé
- **THEN** aucune requête ne quitte la machine : le service répond à partir du corpus local, sans appel modèle ni télémétrie.

### Requirement: Catalogue d'outils et fermeture

Le service SHALL exposer un catalogue **fermé** de quatre outils, et rien d'autre : `sdig_search` (recherche BM25 avec filtres et contexte), `sdig_read` (lecture bornée d'une session, ancrage temporel inclus), `sdig_raw` (sortie d'outil brute — désactivé par défaut, voir « Confidentialité de l'archive ») et `sdig_status` (compteurs, watermark, état de l'index, **sans chemin local**). Chaque outil borné SHALL accepter un paramètre `cursor` de continuation (exigence « Récupération intégrale par continuation »).

Il SHALL refuser par construction : toute sous-commande d'écriture (`ingest`, `refresh`, `index`), toute exécution de commande ou de shell, tout accès à un fichier arbitraire, et l'exposition des **fichiers du jeu d'évaluation** (`eval/natural/…`). Aucun outil SHALL accepter un paramètre de type chemin de fichier, commande, URL ou identifiant de fournisseur. Les paramètres SHALL être bornés (voir l'exigence suivante) et validés avant tout travail ; une valeur hors bornes SHALL être ramenée à la borne et signalée dans la réponse, jamais acceptée en silence.

Un identifiant de preuve (`partId`) SHALL être traité comme une **entrée non fiable** : format strict (préfixe et alphabet connus), existence vérifiée dans le corpus, et résolution du fichier de preuve **confinée** au répertoire des sorties brutes — chemin canonique, refus des liens symboliques et des fichiers spéciaux, aucune traversée de répertoire. Le chemin du fichier n'est jamais fourni par l'appelant : il est **dérivé** d'un identifiant connu du corpus.

Les descriptions d'outils SHALL rappeler que les contenus renvoyés — messages, lignes de commande, sorties d'outils — sont des **données non fiables**, jamais des instructions à suivre ni des commandes à exécuter : une archive peut contenir n'importe quel texte, y compris des consignes adressées au modèle.

#### Scenario: Demande d'écriture

- **WHEN** un appelant demande une ingestion, une réindexation ou une commande shell
- **THEN** la demande est refusée avec une erreur structurée : ces opérations n'existent pas dans le catalogue et restent des actions humaines en CLI.

#### Scenario: Paramètre hors bornes

- **WHEN** `limit`, `ctx`, `tail`, `chars` ou `head` dépassent leur borne
- **THEN** la valeur est ramenée à la borne haute, la réponse le signale, et l'appel se poursuit — un agent ne doit pas pouvoir transformer une borne en erreur silencieuse.

#### Scenario: Identifiant de preuve hostile

- **WHEN** `partId` contient une traversée de répertoire, un chemin absolu, un format inconnu ou un identifiant absent du corpus, ou lorsque le fichier résolu est un lien symbolique ou un fichier spécial
- **THEN** la demande est refusée (`invalid_part`) sans qu'aucun contenu soit renvoyé.

#### Scenario: Fichiers du jeu d'évaluation

- **WHEN** un appelant cherche à lire le jeu d'évaluation ou ses rapports
- **THEN** aucun outil ne le permet : le service n'expose aucun accès fichier, et ces fichiers ne sont pas dans le corpus.

### Requirement: Sorties bornées, jamais silencieuses

Toute réponse SHALL respecter des **plafonds durs**, indépassables par les paramètres : 50 hits par recherche, 200 messages par lecture, 50 messages de contexte, 20 000 caractères par message, 64 Ko par preuve brute, et un budget de **512 Ko** par réponse. Lorsqu'une borne coupe une sortie, la réponse SHALL porter un objet `truncated` avec les compteurs **exacts** (éléments retenus / total, caractères ou octets retenus / total), l'action qui élargit (`limit`, `ctx`, `tail`, `chars`, `head`, `full`) et le **curseur de continuation** (exigence suivante). Aucune coupure ne SHALL être silencieuse : le principe du remède de troncature vaut aussi pour un agent.

#### Scenario: Recherche large

- **WHEN** une recherche correspond à plus de hits que la limite demandée
- **THEN** la réponse indique le nombre de hits retenus et le nombre total disponible, sans laisser croire que le corpus n'en contient pas d'autres.

#### Scenario: Lecture volumineuse

- **WHEN** une lecture de session atteint le plafond de messages ou le budget de réponse
- **THEN** la réponse est tronquée avec ses compteurs, et indique comment obtenir la suite (curseur, ou fenêtrage `around`/`tail`, ou `at` pour borner dans le temps).

#### Scenario: Texte intégral demandé

- **WHEN** `full` est demandé sur un message dépassant le plafond de caractères
- **THEN** la réponse rend le maximum autorisé et le dit explicitement (compteurs + borne atteinte + curseur), et non un silence sur le reste.

### Requirement: Récupération intégrale par continuation

Signaler une coupure ne suffit pas : tout contenu borné SHALL rester **récupérable intégralement**, en plusieurs appels. Chaque réponse tronquée SHALL porter un **curseur de continuation opaque** (`nextCursor`) qui, renvoyé tel quel, restitue la suite exacte du même contenu en conservant la requête d'origine (filtres, ancre, fenêtre, ordre). Aucun plafond caché : en suivant les curseurs jusqu'à épuisement, un appelant SHALL pouvoir obtenir **l'intégralité** d'un message long, d'une liste de hits et d'une sortie d'outil brute. Les segments successifs SHALL se recoller **exactement** : aucun doublon, aucun trou, aucun caractère perdu.

Un curseur SHALL être lié à l'état du corpus. Si la fraîcheur a changé entre deux segments (ingestion, réindexation), le service SHALL refuser le curseur avec une erreur explicite (`stale_cursor`) et inviter à relancer la requête initiale, plutôt que de servir une suite incohérente. Un curseur altéré, tronqué ou provenant d'un autre outil ou d'une autre requête SHALL être refusé (`invalid_cursor`). Un curseur SHALL être inerte : il ne SHALL rien modifier et ne SHALL pas exposer le détail de son contenu (il est opaque pour l'appelant).

#### Scenario: Message plus long que le plafond

- **WHEN** un message dépasse le plafond de caractères par appel, même avec `full`
- **THEN** les appels suivants, guidés par `nextCursor`, restituent la suite, et la concaténation des segments redonne le texte intégral du message.

#### Scenario: Liste de hits plus longue que le plafond

- **WHEN** une recherche compte plus de hits que le plafond par appel
- **THEN** la suite est obtenue par curseur, filtres et ordre conservés, sans doublon ni hit manqué, jusqu'à épuisement.

#### Scenario: Preuve brute plus longue que le plafond

- **WHEN** une sortie d'outil brute dépasse le plafond par appel
- **THEN** elle est restituée par segments successifs jusqu'à l'intégralité, sans perte d'octet.

#### Scenario: Corpus modifié entre deux segments

- **WHEN** le corpus a été ingéré entre un segment et le suivant
- **THEN** le curseur est refusé (`stale_cursor`) et l'appelant sait qu'il doit relancer la requête, plutôt que de recevoir une suite incohérente.

### Requirement: Ancrage temporel et lecture bornée

`sdig_read` SHALL accepter une ancre temporelle (`at`) et appliquer **la sémantique du CLI**, sans réimplémentation divergente : horodatage interprété en UTC, horodatage calendairement valide exigé (une date inexistante ou une heure hors bornes est refusée, jamais reportée), ancre vide refusée, inclusion de l'instant exact, masquage des messages postérieurs effectué **avant** le fenêtrage (`around`, `ctx`, `tail`). La réponse SHALL porter l'ancre résolue, le nombre de messages masqués et le nombre de messages visibles, afin qu'un appelant ne puisse pas confondre « la session s'arrête là » et « on m'a masqué la suite ». Le service SHALL ne détecter ni ne qualifier les changements d'état : il borne la lecture dans le temps, il ne dit pas *ce qui* a changé.

#### Scenario: État à l'instant de la question

- **WHEN** un appelant lit une session avec une ancre placée avant une mutation
- **THEN** la réponse contient les messages jusqu'à l'ancre incluse, l'ancre résolue, le compte masqué et le compte visible.

#### Scenario: Ancre invalide

- **WHEN** l'ancre est vide, d'un format invalide, calendairement impossible, ou absente de la session
- **THEN** la réponse est une erreur structurée nommant le motif, jamais une session entière servie comme si l'option n'existait pas.

#### Scenario: Aucune détection de mutation

- **WHEN** la session contient une modification de configuration ou de permissions
- **THEN** le service ne la signale pas et ne l'interprète pas.

### Requirement: Concurrence, délais et erreurs structurées

Le service SHALL borner le travail simultané (2 requêtes par défaut, valeur configurable) et SHALL répondre un statut **occupé** explicite au-delà, plutôt que d'empiler une file sans borne. Chaque appel SHALL avoir un délai maximal (5 secondes par défaut, configurable) **réellement applicable au travail effectué** : les lectures du projet sont synchrones (fichiers, SQLite), un simple minuteur ne peut pas interrompre cette exécution. Le service SHALL donc soit exécuter le travail dans une unité interruptible (fil d'exécution dédié pouvant être terminé, ou processus), soit garantir par construction un temps de réponse maximal (bornes de travail côté requête : nombre de lignes, d'octets, plafonds SQL) ; le mécanisme retenu SHALL être documenté. À l'expiration, le service SHALL **libérer le créneau de concurrence** et ne SHALL laisser aucun travail orphelin consommer des ressources.

Le résultat SHALL être un partiel **seulement si des éléments exploitables existent déjà** ; sinon la réponse SHALL être une erreur `timeout` — un partiel vide serait une information fausse. Les erreurs SHALL être structurées avec un code stable (`unknown_session`, `invalid_part`, `invalid_anchor`, `invalid_cursor`, `stale_cursor`, `invalid_params`, `forbidden_host`, `busy`, `timeout`, `internal`) et un message qui **ne recopie pas** de contenu d'archive. Un succès vide ambigu SHALL être impossible : une lecture sans message visible dit pourquoi (ancre, fenêtre postérieure, session vide).

#### Scenario: Saturation

- **WHEN** une troisième requête arrive alors que deux sont en cours
- **THEN** elle reçoit un statut occupé explicite, sans attente non bornée, et l'appelant peut réessayer.

#### Scenario: Délai expiré sans résultat exploitable

- **WHEN** le travail dépasse le délai sans avoir produit d'élément utilisable
- **THEN** la réponse est une erreur `timeout`, pas un partiel vide.

#### Scenario: Délai expiré avec résultat exploitable

- **WHEN** le travail dépasse le délai après avoir produit des éléments utilisables
- **THEN** la réponse est partielle, porte la cause d'arrêt `timeout` et le curseur de continuation, et ne laisse pas croire à une exploration complète.

#### Scenario: Créneau libéré

- **WHEN** un appel expire
- **THEN** le créneau de concurrence est rendu immédiatement : l'appel suivant est servi sans attendre la fin d'un travail orphelin.

#### Scenario: Erreur sans fuite

- **WHEN** une erreur survient sur une session ou une preuve
- **THEN** le message d'erreur nomme l'identifiant et le motif, sans citer de contenu de l'archive.

### Requirement: Confidentialité de l'archive

Le service SHALL traiter l'archive comme une donnée privée. Il SHALL écouter en loopback uniquement, n'émettre aucun appel réseau, et SHALL ne journaliser par défaut que les champs d'une **liste autorisée** : nom d'outil, paramètres numériques (limites, fenêtres, offsets), identifiants techniques (session, preuve), compteurs, durée, code d'erreur. Tout texte libre SHALL être exclu par défaut, en particulier la **requête de recherche** : une requête est du contenu — citation privée, nom de fichier, valeur cherchée, voire secret recherché — et ne doit pas atterrir dans un journal. Un mode debug peut journaliser ces champs supplémentaires ; il SHALL être explicitement activé et l'annoncer. Il SHALL ne pas exposer les fichiers du jeu d'évaluation.

Les **sorties d'outils brutes** (`raw/`) étant non triées — stderr, dumps de configuration, contenus que l'utilisateur a affichés dans une session, secrets compris — l'outil `sdig_raw` SHALL être **désactivé par défaut** et ne SHALL être exposé que sur activation explicite par configuration, activation journalisée ; lorsqu'il est actif, la réponse SHALL marquer le contenu comme non vérifié (`unvetted`). Le CLI `sdig raw` n'est pas concerné : l'humain lit ce qu'il demande.

La documentation du service SHALL dire deux choses sans les adoucir : **toute** lecture peut ramener des secrets — les messages ordinaires contiennent des configurations, des chemins et parfois des clés, pas seulement `raw` ; et ce que le service retourne sera vu par le fournisseur du **modèle appelant**. Le service SHALL ne promettre **aucun filtrage de secrets** : ce serait une fausse garantie. La protection retenue est la borne, le défaut fermé pour les sorties non triées, l'absence de journalisation de contenu et la documentation.

#### Scenario: Preuve brute non exposée par défaut

- **WHEN** `sdig_raw` n'est pas activé par configuration
- **THEN** l'outil n'est pas disponible dans le catalogue annoncé, et une demande de preuve brute reçoit une erreur explicite.

#### Scenario: Journal à liste autorisée

- **WHEN** une recherche ou une lecture est servie
- **THEN** la ligne de journal contient l'outil, les paramètres numériques, les identifiants techniques, les compteurs, la durée — et **ni la requête, ni le texte des messages**.

#### Scenario: Preuve brute activée

- **WHEN** l'opérateur active `expose_raw`
- **THEN** l'activation est journalisée et chaque réponse de preuve brute est marquée comme contenu non vérifié, bornée en taille et continue (curseur).

#### Scenario: Secrets hors de `raw`

- **WHEN** un message ordinaire contient une clé, un mot de passe ou un chemin privé
- **THEN** le service ne prétend pas les filtrer : il les borne, ne les journalise pas, et la documentation prévient que la lecture peut les exposer à l'appelant.

### Requirement: Fraîcheur, déterminisme et schéma stable

Chaque réponse SHALL porter une information de fraîcheur (watermark du corpus, horodatage de l'index, version du schéma de corpus) permettant à un appelant de détecter que le corpus a changé entre deux appels — et servant de référence aux curseurs de continuation. À corpus et paramètres identiques, la réponse SHALL être identique (aucune horloge ni échantillonnage dans le contenu). Les champs indisponibles SHALL être absents ou `null`, jamais inventés. Ajouter un champ est compatible ; retirer ou renommer un champ, ou abaisser une borne, SHALL être traité comme un changement de spécification.

#### Scenario: Détection de dérive

- **WHEN** deux appels encadrent une ingestion
- **THEN** les informations de fraîcheur diffèrent et l'appelant peut le constater, sans que le service ait modifié quoi que ce soit.

#### Scenario: Rejeu identique

- **WHEN** le même appel est rejoué sur un corpus inchangé
- **THEN** la réponse est identique, champ pour champ.

#### Scenario: Champ non disponible

- **WHEN** une donnée n'est pas connue (coût absent, modèle inconnu, exit code non capturé)
- **THEN** le champ est absent ou `null`, jamais estimé.
