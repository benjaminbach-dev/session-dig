# Delta mcp — add-mcp-server

## Purpose

Exposer les capacités existantes de session-dig sous forme de serveur MCP local en lecture seule. La v1 facilite la recherche et la lecture de l'archive par les agents, sans shell, sans dupliquer la logique métier et sans promettre une meilleure fidélité du modèle. Elle conserve la sécurité, les limites explicites et l'accès au texte complet, mais ne requiert ni totaux exhaustifs partout, ni résultats partiels après timeout, ni déterminisme de l'enveloppe technique.

## ADDED Requirements

### Requirement: Architecture et transport

Le service SHALL utiliser Node/ESM et le SDK MCP officiel avec Streamable HTTP. Le paquet et sa version SHALL être vérifiés et épinglés dans un change d'implémentation séparé. Le service SHALL écouter exclusivement sur `127.0.0.1:18767`, refuser toute autre adresse configurée, ne faire aucun appel réseau sortant (modèle, proxy, API, télémétrie) et ne jamais écrire dans le corpus, l'index ou la base source. Les ouvertures SQLite SHALL être en lecture seule, sans prétendre garantir une absence absolue de contention avec le CLI.

Le service SHALL valider `Host` selon les formes loopback et port attendus. Un `Origin` absent est permis ; un `Origin` présent SHALL être une origine loopback valide. Les valeurs externes ou malformées, dont `Origin: null`, SHALL être refusées avant tout travail. Ces contrôles SHALL ne pas être présentés comme une authentification ni comme une protection contre tous les clients ou pages d'origine locale. Un token statique optionnel, s'il est configuré, SHALL être exigé sur chaque requête et comparé en temps constant. Sans token, la documentation SHALL indiquer l'absence d'authentification des clients locaux.

Le lancement manuel SHALL être documenté ; l'ajout au manifeste Termux reste une décision propriétaire distincte, pas une conséquence de cette spec.

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
- **THEN** le service travaille exclusivement sur les données locales en lecture seule, sans appel externe ni modification du corpus, de l'index ou de la base source.

### Requirement: Catalogue d'outils et fermeture

Le catalogue SHALL être fermé : `sdig_search`, `sdig_read`, `sdig_status` et, seulement après activation explicite, `sdig_raw`. Aucune ingestion, réindexation, commande shell, lecture de fichier arbitraire ou resource/prompt donnant accès au système de fichiers SHALL être exposée. Les fichiers du jeu d'évaluation SHALL ne pas être lus par ces outils ; cela ne promet pas de retirer des extraits éventuellement déjà copiés dans l'archive.

`sdig_search` SHALL rendre des hits avec extraits, identifiants complets et références exploitables vers `sdig_read`, non le texte intégral paginé des messages. Les hits synthétiques de titre SHALL être distingués des messages et référencer la session. Les filtres et le scoring SHALL réutiliser la logique existante. `sdig_read` SHALL fournir la lecture de session, la fragmentation du texte et l'ancrage. `sdig_status` SHALL fournir compteurs et état sans chemin local.

Les paramètres initiaux et plafonds sont définis dans D2/D3 du design. Les trois outils paginés SHALL accepter `cursor` seul pour continuer ; le mélange d'un curseur avec des paramètres initiaux SHALL être refusé (`invalid_params`). Les types invalides, nombres non entiers, valeurs négatives, tailles de pages nulles et chaînes trop longues SHALL être refusés avant travail. Une limite numérique valide supérieure au maximum SHALL être ramenée au plafond et cette adaptation signalée ; `ctx=0` reste valide.

`partId` SHALL avoir un format strict et correspondre à une référence connue du corpus. Le fichier SHALL être dérivé de cette référence et confiné à `raw/`, avec rejet des traversées, chemins absolus, liens symboliques et fichiers spéciaux. Les vérifications SHALL porter aussi sur le fichier effectivement ouvert, pas seulement sur un chemin testé auparavant.

Les descriptions d'outils SHALL rappeler que le contenu retourné est une donnée non fiable, jamais une instruction à suivre ou une commande à exécuter.

#### Scenario: Recherche puis lecture

- **WHEN** une recherche trouve un message long
- **THEN** le hit présente un extrait identifié comme tel et sa référence session/message ; l'appelant peut obtenir le texte complet par `sdig_read`, sans pagination de ce texte dans `sdig_search`.

#### Scenario: Demande d'écriture ou de fichier arbitraire

- **WHEN** un appelant demande une ingestion, une commande ou une lecture de chemin libre
- **THEN** aucun outil ne permet cette opération et la demande est refusée explicitement.

#### Scenario: Limite supérieure dépassée

- **WHEN** une limite numérique valide dépasse son plafond
- **THEN** le plafond est appliqué et la réponse indique l'ajustement.

#### Scenario: Paramètre invalide

- **WHEN** une taille de page est négative, nulle ou non entière, ou un paramètre a un type invalide
- **THEN** le travail ne démarre pas et la réponse porte `invalid_params`.

#### Scenario: Identifiant de preuve hostile

- **WHEN** une preuve n'est pas référencée dans le corpus, son identifiant est invalide, ou son fichier échappe au confinement ou est un lien/fichier spécial
- **THEN** la demande est refusée (`invalid_part`) sans contenu de fichier retourné.

### Requirement: Sorties bornées et compteurs honnêtes

Chaque réponse SHALL respecter les plafonds par appel : 50 hits, 200 messages distincts, 20 000 caractères de texte par message, 65 536 octets de preuve brute, et 524 288 octets de réponse MCP sérialisée UTF-8, enveloppe et curseurs compris. Le contexte SHALL être limité à 5 voisins par côté dans search et 50 par côté dans read, sous le budget global.

Toute coupure SHALL être explicite dans `truncated`. Les quantités retenues SHALL être exactes ; les totaux SHALL être exacts quand connus, sinon `null`, jamais estimés. Le service SHALL ne pas être tenu de calculer un total exhaustif seulement pour renseigner ce champ. Un total inconnu SHALL ne pas être interprété comme une absence de suite.

Quand une liste de hits ou un contenu de lecture a une suite, la réponse SHALL porter `truncated.nextCursor`. Une coupure d'extrait de recherche SHALL fournir une référence vers `read`, sans exiger un curseur pour ce texte. `full` SHALL respecter les plafonds et ne SHALL pas rendre la suite du texte inaccessible. Les comptes de lecture disponibles (`maskedCount`, `visible`, `total`) SHALL conserver la sémantique CLI.

#### Scenario: Total de recherche inconnu

- **WHEN** une page de hits est disponible sans calcul exhaustif du nombre total de correspondances
- **THEN** le nombre rendu est exact, le total est `null`, et un curseur est fourni si des hits restent ; le résultat ne prétend pas que le total égale la taille de page.

#### Scenario: Budget global atteint

- **WHEN** une page atteindrait le budget de réponse, métadonnées comprises
- **THEN** le contenu est réduit avant sérialisation finale, la coupure est signalée et la continuation permet de reprendre les éléments non rendus.

#### Scenario: Full atteint le plafond

- **WHEN** `full` est demandé sur un message plus long que le plafond
- **THEN** le fragment est borné, la coupure est signalée et sa suite est accessible par curseur dans `sdig_read`.

### Requirement: Continuation adaptée à chaque outil

La continuation SHALL préserver la requête initiale, ses filtres, son ordre et, pour read, l'ancre et la fenêtre. `sdig_search` SHALL paginer uniquement la liste des hits, avec un ordre stable et un départage des scores égaux ; les extraits et voisins renvoient à read pour leur texte intégral. La pagination des hits SHALL précéder le regroupement de présentation par session.

`sdig_read` SHALL permettre de récupérer tous les messages et textes de la vue choisie, par pages et fragments identifiés (message, offset, fin de message). `sdig_raw`, lorsqu'il est actif, SHALL permettre de récupérer toute la preuve par fragments avec offsets. Ses paramètres `head` et `maxBytes` bornent une page, pas la quantité totale récupérable. Les unités d'offset et l'encodage SHALL être documentés. Les fragments SHALL se recoller sans trou, doublon ou caractère perdu ; la preuve brute SHALL se reconstituer sans perte d'octet.

Le curseur SHALL être opaque, inerte, validé et lié à l'outil, à la requête initiale et à l'état lu. Un curseur altéré ou étranger SHALL être refusé (`invalid_cursor`) ; un changement de génération SHALL donner `stale_cursor`, sans suite mélangeant des états. Un curseur expiré ou perdu SHALL être refusé explicitement, jamais traité comme une nouvelle requête. L'identité binaire des curseurs n'est pas exigée. Si un état de curseur est conservé côté serveur, ses bornes mémoire et sa durée de vie SHALL être documentées. Aucun curseur SHALL contourner la désactivation de raw.

#### Scenario: Liste de hits au-delà du plafond

- **WHEN** une recherche a plus de hits qu'une page ne peut en contenir
- **THEN** les pages successives restituent la liste, sans hit manqué ou dupliqué sur un corpus inchangé, sans obligation de rendre le texte complet des hits.

#### Scenario: Recollement de messages Unicode

- **WHEN** une vue contient des messages dépassant les plafonds, avec accents et emoji
- **THEN** la continuation conserve ancre et fenêtre, chaque fragment est identifiable et le recollement restitue les textes exacts sans message masqué temporellement ni caractère perdu.

#### Scenario: Preuve volumineuse

- **WHEN** raw est actif et une preuve dépasse la limite de lignes ou d'octets d'une page
- **THEN** les curseurs permettent d'en restituer tous les octets, sans désactiver les plafonds par appel.

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

### Requirement: Concurrence, timeout simple et arrêt réel

Le service SHALL borner le travail simultané à 2 appels par défaut (valeur configurable et bornée), sans file non bornée ; la saturation SHALL donner `busy`. Les lectures synchrones SHALL être isolées du serveur HTTP dans une unité dont l'arrêt peut être demandé et observé (worker ou processus, choix documenté et testé sur la pile réelle). Un minuteur seul ou un LIMIT SQL SHALL ne pas être présenté comme une interruption du travail ou une preuve de durée maximale.

À expiration du délai (5 s par défaut, configurable), le service SHALL retourner une erreur `timeout`, sans résultat partiel ni curseur issu du travail interrompu, et SHALL demander l'arrêt du travail. Le créneau SHALL rester occupé jusqu'à confirmation de l'arrêt effectif ; les résultats tardifs SHALL être ignorés. La v1 ne promet pas une terminaison instantanée. Si l'arrêt échoue, l'unité SHALL rester indisponible et l'incident être signalé plutôt que de dépasser la concurrence ou d'abandonner silencieusement du travail orphelin.

Les erreurs applicatives SHALL avoir des codes stables (`unknown_session`, `invalid_part`, `invalid_anchor`, `invalid_cursor`, `stale_cursor`, `invalid_params`, `forbidden_host`, `busy`, `timeout`, `internal`), sans copie de contenu d'archive, requête libre ou secret. Les identifiants repris dans les messages SHALL être validés. Les erreurs de protocole MCP restent distinctes.

#### Scenario: Saturation

- **WHEN** deux unités travaillent ou sont en cours d'arrêt et qu'un troisième appel arrive
- **THEN** il reçoit `busy`, sans création d'une troisième unité active.

#### Scenario: Timeout même avec données intermédiaires

- **WHEN** le délai expire, que le calcul ait produit ou non des données intermédiaires
- **THEN** la réponse porte seulement l'erreur `timeout`, sans résultat partiel ni nouveau curseur, et l'arrêt est demandé.

#### Scenario: Créneau rendu après arrêt

- **WHEN** l'arrêt du travail expiré est confirmé
- **THEN** le créneau devient réutilisable, aucun travail de cet appel ne continue et tout résultat tardif est ignoré.

#### Scenario: Échec d'arrêt

- **WHEN** l'unité ne peut pas être arrêtée comme prévu
- **THEN** elle reste indisponible, l'incident est signalé et aucun nouveau travail n'est lancé dans son créneau prétendument libre.

### Requirement: Confidentialité de l'archive

Les journaux par défaut SHALL être limités à une liste autorisée : nom d'outil, limites/fenêtres/offsets numériques, identifiants techniques validés, compteurs connus, durée, code d'erreur. Ils SHALL exclure query, filtres libres, curseurs, tokens, messages et sorties brutes. Un mode debug de contenu SHALL nécessiter une activation explicite annoncée ; aucun secret d'authentification SHALL être journalisé.

`sdig_raw` SHALL être absent par défaut, activable explicitement par configuration (`expose_raw`), activation journalisée. Toutes ses pages SHALL porter `unvetted: true`. Toute lecture, y compris un message ordinaire, peut contenir des secrets ; la documentation SHALL le dire et ne SHALL promettre aucun filtrage ou anonymisation. La borne de taille n'est pas une garantie de confidentialité. La documentation SHALL rappeler que le service n'appelle aucun modèle mais que le client peut transmettre les réponses au fournisseur du modèle appelant.

#### Scenario: Journaux sans contenu

- **WHEN** un appel contient une citation privée dans query ou un filtre
- **THEN** ce texte n'apparaît pas dans les journaux par défaut, même en cas d'erreur.

#### Scenario: Raw fermé par défaut

- **WHEN** raw n'est pas activé
- **THEN** il est absent du catalogue et une demande directe ou par curseur ne permet pas de lire une preuve.

#### Scenario: Raw activé

- **WHEN** l'opérateur active raw et lit une preuve
- **THEN** l'activation est journalisée et chaque page est bornée et marquée `unvetted: true`.

#### Scenario: Secret dans un message ordinaire

- **WHEN** un message lu contient un secret
- **THEN** le service ne promet pas de le supprimer ; le contenu n'est pas journalisé par défaut et la documentation avertit de son exposition possible au modèle appelant.

### Requirement: Fraîcheur, déterminisme des données et schéma stable

Les résultats SHALL porter les informations disponibles de fraîcheur (watermarks du corpus, horodatage de l'index, version du schéma), absentes ou `null` si indisponibles. Une continuation SHALL être liée à une génération vérifiée ; le service SHALL ne pas émettre de curseur prétendument sûr sans pouvoir identifier l'état lu. Un changement détecté pendant la lecture SHALL invalider la page plutôt que mélanger des générations.

À corpus/index et paramètres identiques, les données d'un appel terminé avec succès et leur ordre SHALL être identiques. Cette exigence ne porte ni sur la représentation des curseurs, ni sur les identifiants de requête ou durées, ni sur les erreurs de saturation/timeout. Les curseurs peuvent différer s'ils permettent la même continuation. Ajouter un champ est compatible ; supprimer/renommer un champ ou réduire une borne SHALL nécessiter une évolution de spec. Une donnée inconnue SHALL être absente ou `null`, jamais inventée.

#### Scenario: Rejeu des données

- **WHEN** le même appel réussit deux fois sur le même corpus/index
- **THEN** les données et l'ordre sont identiques ; d'éventuels curseurs différents permettent la même suite.

#### Scenario: Fraîcheur modifiée

- **WHEN** deux lectures encadrent une ingestion ou réindexation
- **THEN** l'état modifié est détectable et les anciens curseurs ne servent pas de suite incohérente.

#### Scenario: Donnée inconnue

- **WHEN** un total de recherche ou une autre donnée n'est pas disponible
- **THEN** le champ est absent ou `null` selon son contrat, jamais estimé ni remplacé par zéro.
