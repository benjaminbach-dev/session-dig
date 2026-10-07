# Delta mcp — add-mcp-stdio

## MODIFIED Requirements

### Requirement: Architecture et transport

Le service SHALL utiliser Node/ESM et le SDK MCP officiel. Le paquet et sa version SHALL être vérifiés et épinglés dans un change d'implémentation séparé. Le service SHALL offrir **deux modes de transport** — Streamable HTTP et stdio — sélectionnables au lancement ; **un seul mode SHALL être actif par processus**, aucun double transport simultané n'est admis, et toute combinaison de modes ou d'options propre à un mode dans l'autre SHALL être refusée explicitement avant tout travail et avant toute ouverture de transport.

En mode **Streamable HTTP**, le service SHALL écouter exclusivement sur `127.0.0.1:18767` et refuser toute autre adresse configurée. En mode **stdio**, le service SHALL communiquer par l'entrée standard (lecture du client) et la sortie standard (réponses MCP) : il ne SHALL lier **aucun port TCP**, la sortie standard SHALL être **réservée au protocole MCP** — aucun journal, aucun diagnostic, aucun texte d'aide — et les journaux SHALL être écrits sur la sortie d'erreur uniquement. Le mode stdio SHALL être présenté comme **au moins aussi confiné** que le mode HTTP, précisément parce qu'aucun socket n'est ouvert et qu'aucun autre processus que le client parent ne peut le joindre.

Dans les deux modes, le service SHALL ne faire aucun appel réseau sortant (modèle, proxy, API, télémétrie) et jamais écrire de **données** dans le corpus, l'index ou la base source. Les ouvertures SQLite SHALL être en lecture seule, sans prétendre garantir une absence absolue de contention avec le CLI. **Exception étroite — décision utilisateur du 01/10/2026** : le service PEUT créer ou laisser les annexes natives de coordination SQLite de la vue `index.db-wal`/`index.db-shm` ; aucune donnée du corpus, de la vue ou de la base source n'est écrite, aucune suppression/cleanup manuel sous concurrence, `immutable=1` et l'ignorance d'un WAL vivant SHALL rester exclus, et si le stockage ne permet pas cette coordination le service SHALL refuser de façon bornée (`view_unavailable`) sans autre écriture.

En mode **HTTP uniquement**, le service SHALL valider `Host` selon les formes loopback et port attendus. Un `Origin` absent est permis ; un `Origin` présent SHALL être une origine loopback valide. Les valeurs externes ou malformées, dont `Origin: null`, SHALL être refusées avant tout travail. Ces contrôles ne SHALL jamais être présentés comme une authentification ni comme une protection contre tous les clients ou pages d'origine locale. Un token statique optionnel, s'il est configuré, SHALL être exigé sur chaque requête et comparé en temps constant. Sans token, la documentation SHALL indiquer l'absence d'authentification des clients locaux. En mode **stdio**, les contrôles `Host`, `Origin` et token ne SHALL **pas être appliqués** — il n'existe ni socket, ni en-tête, ni requête HTTP — et cette absence SHALL être justifiée par le fait que le client possède le processus et que le service n'écoute rien, jamais présentée comme une authentification ni comme un affaiblissement silencieux.

Le lancement SHALL rester documenté, sans installation automatique, sans autostart, sans service ni supervision, et sans travail de fond détaché survivant. En HTTP, le lancement SHALL rester **manuel** (`sdig mcp`). En stdio, le serveur SHALL être **lancé par le client MCP lui-même** (spawn d'un processus enfant) et sa durée de vie SHALL être liée à celle du client : la fermeture de l'entrée standard ou la mort du client SHALL terminer le serveur. Le mode **HTTP reste le défaut** lorsque `--stdio` n'est pas fourni. L'ajout du mode stdio **lève explicitement** l'exclusion « aucun deuxième transport » du change `add-mcp-server` (YAGNI d'alors), sur besoin démontré et consigné dans le design de ce change ; il ne supprime ni ne déprécie le mode HTTP. L'ajout au manifeste Termux reste une décision propriétaire distincte, pas une conséquence de cette spec.

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

#### Scenario: Mode stdio sans socket

- **WHEN** le service est lancé en mode stdio
- **THEN** il ne lie aucun port TCP, la sortie standard ne porte que des messages du protocole MCP, et les journaux vont sur la sortie d'erreur.

#### Scenario: Mode HTTP par défaut

- **WHEN** `sdig mcp` est lancé sans le flag `--stdio`
- **THEN** le comportement est celui du mode Streamable HTTP existant (écoute exclusive `127.0.0.1:18767`, contrôles Host/Origin et token éventuel inchangés), sans qu'aucun transport stdio ne soit activé.

### Requirement: Concurrence mono-travail et durée honnête

Le service SHALL traiter **un seul appel d'outil à la fois**. À l'admission, si le créneau est occupé, l'appel SHALL recevoir `busy`, sans file applicative supplémentaire ; s'il est libre, l'appel peut démarrer. Les tampons du transport ne sont pas une file de travail applicative : une requête arrivée pendant un calcul synchrone peut être traitée après sa fin puis admise. Aucune réactivité immédiate ni détection rétrospective de saturation n'est promise. Un durcissement ultérieur (concurrence >1, timeout applicatif avec arrêt observable) reste soumis à accord, hors MVP.

Les limites de taille (exigence « Sorties bornées ») SHALL borner le volume des réponses, **pas la durée du calcul** : un `LIMIT` SQL ne fixe aucune borne de temps, et le contrat SHALL ne pas prétendre le contraire. Le service SHALL présenter honnêtement ses limites (aucun marqueur d'annulation simulé) : aucun code `timeout` tant qu'un arrêt réel n'est pas documenté et prouvé sur la pile réelle (appels natifs SQLite compris) ; pas de `Promise.race` présentée comme annulation. Un travail lent peut retarder tout le serveur — le contrat SHALL le dire explicitement, plutôt que de promettre une réactivité garantie. Un timeout ou une déconnexion du client ne SHALL pas être présenté comme la preuve d'un arrêt du calcul serveur.

**En mode HTTP**, l'arrêt et la reprise du serveur SHALL rester manuels et documentés, avec fermeture des connexions à l'arrêt normal et sans travail de fond détaché survivant. **En mode stdio**, la durée de vie est celle du client (exigence « Transport stdio ») : l'arrêt provient du client (fermeture de l'entrée standard, mort du processus parent, signal) et la reprise relève du client qui relance le serveur ; ce n'est plus un arrêt « manuel » d'opérateur, mais **aucun des deux modes** ne SHALL laisser de travail de fond détaché survivre à l'arrêt. Dans les deux modes, les seules traces persistantes tolérées après arrêt sont les annexes natives SQLite `index.db-wal`/`index.db-shm` de la vue (décision utilisateur du 01/10/2026). Le MCP en lecture seule ne SHALL jamais lancer une réparation ou une réconciliation ; un état d'ingestion interrompue relève du CLI.

Les erreurs applicatives SHALL avoir des codes stables (`unknown_session`, `invalid_anchor`, `invalid_cursor`, `stale_cursor`, `invalid_params`, `view_unavailable`, `forbidden_host`, `busy`, `internal`), sans copie de contenu d'archive, requête libre ou secret. Une vue absente ou périmée SHALL donner `view_unavailable`, motif technique distingué sans chemin local ; une requête sans terme exploitable SHALL être `invalid_params`, jamais `internal`. Les identifiants repris dans les messages SHALL être validés. Les erreurs de protocole MCP restent distinctes.

#### Scenario: Saturation mono-travail

- **WHEN** le gestionnaire d'admission traite un appel alors que le créneau de travail est encore occupé
- **THEN** il répond `busy`, sans mise en file applicative ni travail concurrent ; si le calcul synchrone précédent a empêché cette admission jusqu'à sa fin, l'appel peut être admis une fois le créneau libre.

#### Scenario: Pas de faux timeout

- **WHEN** un calcul de lecture dure plus longtemps que le délai attendu par le client
- **THEN** aucun timeout applicatif garanti ni annulation n'est revendiqué par le MVP ; une déconnexion client ne libère pas prématurément le créneau d'un travail toujours actif.

#### Scenario: Requête lente pendant un calcul

- **WHEN** un calcul de lecture s'étend dans la durée
- **THEN** le serveur peut être momentanément non réactif pour les autres requêtes ; cette limite est documentée ; en HTTP, l'opérateur peut redémarrer manuellement le serveur, en stdio c'est le client qui le relance (spawn) ; et les données restent cohérentes (lecture seule).

#### Scenario: Vue indisponible

- **WHEN** la vue est absente ou périmée au moment d'un appel
- **THEN** la réponse porte `view_unavailable` avec son motif, sans chemin local ni contenu privé.

## ADDED Requirements

### Requirement: Transport stdio

Le mode stdio SHALL exposer **exactement le même** catalogue d'outils, les mêmes handlers métier, les mêmes validations d'entrée **des arguments d'outils**, les mêmes codes d'erreur fermés, le même budget d'enveloppe sérialisée et les mêmes contrats de réponse que le mode HTTP : le transport ne SHALL changer ni la sémantique métier ni les bornes. Les validations **protocolaires** diffèrent par construction : en HTTP, une pré-validation dédiée précède le SDK (méthodes, identifiants, corps borné, version de protocole) ; en stdio, le SDK bas niveau du transport parse et borne les trames — cette répartition ne SHALL pas être présentée comme un écart de validation métier. En mode stdio, la sortie standard SHALL être **réservée EXCLUSIVEMENT aux messages du protocole MCP** ; toute journalisation, tout avertissement, toute trace, toute aide et tout message d'erreur SHALL aller sur la sortie d'erreur. Aucun port TCP SHALL être lié et aucun appel réseau sortant n'est admis. Le tampon de lecture de l'entrée standard SHALL être **borné explicitement** : une trame dépassant la borne termine le transport par erreur — un **quatrième chemin d'arrêt**, distinct de l'EOF, des signaux et de la mort du client — sans travail détaché ; la valeur (défaut du SDK épinglé, 10 Mio, ou valeur inférieure explicite) SHALL être consignée à l'implémentation. Le serveur SHALL être lancé par le client MCP sous forme de processus enfant, et sa durée de vie SHALL être liée à celle du client : la fermeture de l'entrée standard ou la mort du client SHALL terminer le serveur, **sans travail de fond détaché survivant**. L'arrêt propre (SIGINT/SIGTERM → attente terminée du travail actif puis purge du cache de curseurs) SHALL rester assuré lorsque le signal est reçu ; la mort du client, sans signal, est un arrêt brutal qui ne laisse de même aucun travail détaché. L'admission mono-travail SHALL rester active en stdio : un client unique peut émettre des requêtes concurrentes, qui reçoivent `busy` selon le contrat existant, sans file applicative. Le cache de curseurs reste **process-local** : un redémarrage du client crée un nouveau processus serveur et invalide les curseurs précédents, qui SHALL être refusés (`invalid_cursor`) et jamais traités comme de nouvelles requêtes ; aucun cache persistant n'est introduit. En stdio, les contrôles `Host`, `Origin` et token ne s'appliquent pas — il n'existe ni socket, ni en-tête — et cette absence ne SHALL jamais être présentée comme une authentification ni comme une réduction de confinement, le mode n'écoutant rien. Aucun nouvel outil, aucun paramètre métier nouveau, aucune modification des handlers, du budget de réponse ou des codes d'erreur n'est introduit par ce transport.

#### Scenario: Lancement stdio et appel d'outil

- **WHEN** un client MCP lance `sdig mcp --stdio` et appelle un outil du catalogue (`sdig_search`, `sdig_read` ou `sdig_status`)
- **THEN** l'appel réussit avec les mêmes contrats, bornes et codes d'erreur que le mode HTTP, sans qu'aucun port TCP ait été lié.

#### Scenario: Journalisation sur stderr uniquement

- **WHEN** le service journalise une activité ou un refus en mode stdio
- **THEN** la ligne est écrite sur la sortie d'erreur et jamais sur la sortie standard ; la sortie standard ne porte que des trames du protocole MCP.

#### Scenario: Sortie standard polluée

- **WHEN** du code écrit sur la sortie standard autre chose qu'un message du protocole MCP (aide, avertissement de dépendance, trace de diagnostic)
- **THEN** c'est un défaut : la sortie standard ne doit porter que le protocole, et tout diagnostic doit être redirigé sur la sortie d'erreur — la pollution de stdout n'est ni tolérée ni silencieuse.

#### Scenario: Arrêt propre et mort du client

- **WHEN** le client MCP ferme l'entrée standard ou se termine, ou lorsque le serveur reçoit `SIGINT`/`SIGTERM`
- **THEN** le serveur s'arrête sans travail de fond détaché survivant ; sur signal, il attend la fin du travail actif et purge le cache de curseurs avant de sortir.

#### Scenario: Curseur process-local après redémarrage

- **WHEN** un curseur de `sdig_read` obtenu auprès d'un processus stdio précédent est réutilisé après redémarrage du client
- **THEN** il est refusé (`invalid_cursor`), jamais traité comme une nouvelle requête, le cache de curseurs étant process-local et mort avec le processus précédent.

#### Scenario: Trame stdin dépassant la borne

- **WHEN** une trame écrite sur l'entrée standard dépasse la borne du tampon de lecture
- **THEN** le transport est terminé par erreur (quatrième chemin d'arrêt, distinct de l'EOF, des signaux et de la mort du client), sans travail détaché survivant ; la borne appliquée est consignée.

#### Scenario: Combinaison de modes refusée

- **WHEN** le lancement combine `--stdio` avec une option de connexion propre au mode HTTP, ou répète le flag de mode
- **THEN** le démarrage est refusé explicitement, sans écho de l'argument, avant toute création de transport et sans lier de port.
