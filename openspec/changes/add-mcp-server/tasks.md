# Tâches — add-mcp-server

> **Recentrage à la demande explicite de l'utilisateur** : outil léger pour un dev solo, bases solides et extensibles. Le MVP contribue au jalon `J-MCP` (« usage solo local validé sur PC », voir proposition `scale-corpus`). Le lot A d'intégrité précède l'usage sur corpus réel ; la clôture complète de scale-corpus et les extensions ne bloquent pas ce jalon. Aucun code MCP n'est livré par ce patch documentaire.

## Phase spec et historique

- [x] Écrire proposition, design et delta de la capacité `mcp`.
- [x] Conserver les protections des revues précédentes : lecture seule, loopback et contrôles Host/Origin, token optionnel, journaux en liste autorisée, données non fiables, ancrage identique au CLI ; notes de confinement raw conservées pour une extension future.
- [x] Recentrer la v1 le 20/09 (décision historique) : recherche par extraits référencés et pagination des hits ; lecture complète par fragments read/raw ; totaux exacts seulement quand connus ; déterminisme des données plutôt que de l'enveloppe. **Le périmètre de livraison de cette décision est remplacé par le recentrage solo ci-dessous.**
- [x] Intégrer la relecture croisée Advisor du 26/09 : filtre source, fraîcheur par source, génération publiée, validation des partIds, status multi-source, priorité hits puis voisins, `view_unavailable`, ordre binaire stable et pagination SQL. Les détails search/raw historiques ne sont plus des obligations du MVP ; les garanties de lecture et de provenance restent requises.
- [x] Recentrage solo demandé par l'utilisateur : search/read/status ; search top-k **sans curseur** ; lecture complète par fragments conservée ; mono-travail sans timeout applicatif garanti ; confidentialité et descriptions d'outils obligatoires dès le MVP. Extensions conditionnelles, sans commande implicite de les réaliser.
- [x] Valider le patch documentaire final : OpenSpec global strict (6/6 éléments), `git diff --check`, relecture et corrections de cohérence des quatre documents. Validation documentaire seulement, pas une attestation d'implémentation du MVP.
- [x] Commit/push documentaire réalisé (`19c637f`, présent sur `origin/main` ; vérifié le 01/10/2026). Cette case n'autorise aucun début d'implémentation implicite.

## Phase implémentation : MVP (M1–M4, contribue à J-MCP ; sur accord)

### M1 — Transport et contrat commun

> **Lot M1a livré le 01/10/2026 — contrats seuls.** Le SDK officiel est vérifié et épinglé ; les schémas et descriptions des trois outils existent sous `src/mcp/`. Ce lot **ne monte pas** le transport Streamable HTTP et **n'exécute aucun** handler : les cases M1 ci-dessous restent donc largement incomplètes.
>
> - [x] Épingler le SDK MCP officiel : `@modelcontextprotocol/sdk` `1.31.0` (publié 2026-09-28, registre npm) + validation directe `zod` `3.25.76`. API recoupée sur le paquet installé et testée via `McpServer` + `Client` réel (`InMemoryTransport`). Context7 indisponible le 01/10/2026 (fallback npm/paquet documenté).
> - [x] Contrats fermés `sdig_search`/`sdig_read`/`sdig_status` sous `src/mcp/` : entrées strictes utilisables par `McpServer.registerTool`, refus des propriétés inconnues et de `cursor` hors read, types/entiers sûrs/bornes/tailles, plafonds ramenés avec adaptations, `ctx=0` admis et pages nulles refusées.
> - [x] Sorties décrites comme contrat MCP (hits typés message/titre, référence read obligatoire, voisins séparés, groupement, `topK`/`count`, `total` inconnu `null`, `nextCursor` refusé sur search), fragments read `offset`/`end`/`complete` au contrat (unités points de code Unicode, `end` exclu, UTF-8), `freshness` dans chaque réponse (`indexMtime` fini fractionnaire, `corpusVersion` entier de schéma), compteurs par source `null` si inconnus, fidélité pi aux valeurs exactes du format commun.
> - [x] Descriptions des trois outils (secrets/fournisseur du modèle, contenu non fiable jamais exécuté, top-k sans curseur) ; erreurs applicatives à messages figés par code ; budget d'enveloppe 524 288 octets UTF-8.
> - [ ] Fragmentation read (implémentation, tests de recollement) et validation authentifiée du curseur read : **M3, non livrés**.
>
> **Lot M1b livré le 01/10/2026 — transport HTTP, garde-fous, admission (M1 toujours partiel).**
>
> - [x] Fabrique serveur Streamable HTTP stateless sur le SDK officiel (`src/mcp/server.js`) : handlers métier **injectés et requis** (exactement les 3), aucun repli factice ; port production `127.0.0.1:18767` refusant toute autre adresse/port ; primitive de test éphémère sur `127.0.0.1`.
> - [x] Garde-fous : `Host`/`Origin` en syntaxe **brute** (loopback exact, port d'écoute sans zéro de tête, pas de chemin/%2e/`\`/127.1/port 0/65536, en-têtes dupliqués refusés), jeton Bearer optionnel configuré strictement (absent/null = désactivé ; `''`/espaces/type non-chaîne/trop long refusés au constructeur ; SHA-256 + `timingSafeEqual`), corps borné 256 Kio, en-têtes 16 Kio, aucun egress ni écriture corpus.
> - [x] Anti-fuite SDK : entête `mcp-protocol-version` prévalidée, identifiant JSON-RPC borné, paramètres connus malformés → `-32602` générique, toute réponse d'erreur SDK sanitizée (code/message fermés, `data` retiré) ; validation M1a avant handler ; budget d'enveloppe 524 288 octets (`content` toujours présent).
> - [x] Admission mono-travail server-global (bloquée dès la fermeture, avant et après lecture du corps, `busy` sans file, créneau tenu malgré déconnexion) et `close()` qui annule les corps incomplets, attend le handler actif **et la réponse en cours**, puis `dispose` (échec propagé, idempotent) ; `close` avant `start` cohérent, `start` après `close` refusé.
> - [x] Route fixe `/mcp` (toute autre route → 404) ; tests sur stubs synthétiques, port OS éphémère, **sans lier le port de production 18767**.
> - [ ] Serveur de production lancé sur le corpus réel avec SQLite en lecture seule : **non livré** (handlers métier et accès données = lots suivants).
> - [ ] Commande CLI `sdig mcp` / bin autonome : **non livrée** ; jalon PC jamais coché.
>
> **Validation parent M1b (01/10/2026)** : `npm test` **339/339**, OpenSpec et `git diff --check` OK, vérifications adversariales (en-têtes Host/Origin/version sentinelles, identifiants 200 k, params/initialize invalides) — erreurs 73-79 octets sans écho. Client MCP HTTP officiel exercé en **local éphémère** ; ce n'est pas une validation PC du jalon.
>
> **Lot data M1 (accès lecture seule, snapshot, fraîcheur) — sous-lot livré le 01/10/2026 ; M1 complet NON atteint, M3 non livré, jalon PC non coché.**
>
> - [x] `src/mcp/data.js` : ouverture readonly (`fileMustExist`, `query_only`), vérification schéma/layout/watermarks, callback SYNCHRONE dans un seul `BEGIN`/`COMMIT`, connexion fermée sur succès/erreur/refus ; décision de fraîcheur reprise de `checkFresh` (logique commune), pas de protocole dupliqué.
> - [x] Fraîcheur par source exposable (opencode `message`/`session` ; pi `token` + nombre de fichiers suivis), `indexMtime`/`corpusVersion` diagnostics, aucune génération ni curseur fabriqué ; raisons fermées `missing_view`/`invalid_schema`/`missing_state`/`stale_view`/`pi_divergence`/`changed_publication`.
> - [x] Détection de changement AVANT rendu : **état publié capturé une seule fois** (stat avant/après lecture, JSON strict) alimentant `checkFresh` (option `state` additive) et les projections ; **identité de l'index capturée avant ouverture** puis vérifiée après établissement du snapshot et avant rendu ; republication d'état, remplacement d'`index.db` (inode) et COMMIT concurrent (`data_version` relu après COMMIT, jamais pendant la transaction) → `view_unavailable`.
> - [x] Callback purement synchrone : `AsyncFunction`/`AsyncGeneratorFunction`/`GeneratorFunction` refusés **avant invocation** ; `Promise` renvoyé refusé sans être attendu, rejet de Promise native neutralisé (aucune prétention d'annulation, aucun `.then` arbitraire) ; exception → `internal` bornée sans écho.
> - [x] `availability` : `stat` seul, type attendu (`opencode` fichier, `pi` répertoire), absence → `false`, accès refusé → `null`, config propriétaire explicite, noms inconnus jamais renvoyés.
> - [x] Façade lecture seule (pas d'`exec`/`pragma`/`attach`, statements `reader` seulement) ; callback documenté comme code interne de confiance, **pas un bac à sable** ni une entrée d'agent.
> - [ ] Handler `sdig_status` (disponibilité/scans) et handlers search/read : **non livrés** ; aucun lancement utilisateur.
> - [ ] Génération publiée persistante / curseur read : **M3, non livrés**.
> - **WAL — exception étroite autorisée (décision utilisateur du 01/10/2026)** : SQLite peut créer/laisser les annexes natives `index.db-wal`/`index.db-shm` de la vue (mesures synthetic : `-shm` 32 768 o, `-wal` 0 o après `readonly.close`, SHA-256 de `index.db` identique). Conformité **limitée** à ces annexes : aucune donnée du corpus/vue/base source écrite, aucun cleanup manuel sous concurrence, `immutable=1` et l'ignorance d'un WAL vivant exclus, refus borné si le stockage ne permet pas la coordination ; aucune extension à d'autres fichiers ni sources ; spec explicitement adaptée après accord utilisateur ; producteurs CLI non modifiés.
> - [x] Test **multiprocessus WAL** (`spawnSync`, env sans `NODE_OPTIONS`, timeout borné) entre deux SELECT du callback : snapshot isolé, refus `changed_publication` (`data_version`), lecture suivante voit la publication (vue opencode en avance permise). Validation parent **effective : `npm test` 374/374 (exit 0), OpenSpec `--all --strict` 6/6, `git diff --check` propre** — sans claim de validation PC.

- [ ] Vérifier puis épingler le paquet/version du SDK MCP officiel et son transport Streamable HTTP.
- [ ] Serveur sur `127.0.0.1:18767`, Host/Origin validés, token optionnel, aucun egress, SQLite en lecture seule, journaux sans contenu sur stderr par défaut. Aucun deuxième transport ni dépendance de lancement à Agora.
- [ ] Catalogue fermé : `sdig_search`, `sdig_read`, `sdig_status` ; `sdig_raw` absent quelle que soit la configuration MVP.
- [ ] Fixer les schémas d'entrée/sortie, les unités d'offset et l'encodage de read, les budgets et erreurs applicatives distinctes du protocole MCP. Décrire les outils et les risques de confidentialité dès ce lot ; reprendre le signal structuré de fidélité pi du change add-pi-adapter dans search/read, chaque page read comprise et métadonnées incluses dans le budget (branches aplaties, éditions non appliquées ; pas une détection par session).

### M2 — Search

- [ ] Façade sur le moteur partagé : extraits, références vers read, source filtrant messages et titres, source inconnue = zéro hit, `agent` exact (pi v0 = null), préfixe de session littéral échappé, voisinage borné ; pas de scoring dupliqué.
- [ ] Top-k sans pagination : ordre stable avec départage binaire des IDs complets avant sélection/regroupement ; aucun `cursor` accepté ni `nextCursor` émis. Décrire l'affinage par requête et filtres.
- [ ] Budgets : hits prioritaires puis voisins ; coupures et réduction éventuelle sous `limit` explicites ; compte rendu exact, total inconnu = `null`, aucun comptage exhaustif obligatoire.

### M3 — Read et status

- [ ] `sdig_read` sur la logique partagée : autour/ctx/tail/at, UTC et validation calendaire, masquage avant fenêtre, `anchor`/`maskedCount` et comptes CLI préservés.
- [ ] Pagination de la vue choisie et fragmentation des messages longs (ID, offset, fin de message) : tout son contenu reste récupérable, même avec `full` et plafonds. Aucun faux contenu intégral tronqué.
- [ ] Curseur read seul, lié à requête/ancre/fenêtre/génération ; refus des curseurs altérés/étrangers/périmés, du mélange cursor + nouvelle requête ; dernière page sans curseur, progression effective.
- [ ] Accès SQL par fenêtres et extraction des fragments avant assemblage, sans matérialiser une session entière pour la découper ; un snapshot par page. C'est un travail à valider, pas un acquis du lecteur CLI actuel.
- [ ] `sdig_status` : compteurs connus, disponibilité de chaque source configurée, état ingéré, watermark ; source absente archivée signalée sans effacement, compte par source inconnu = `null`, aucun chemin local rendu.
- [ ] Fraîcheur par source ; divergence jeton pi vue/état => `view_unavailable` de la vue fusionnée jusqu'à réconciliation CLI. Les lectures réussies sont cohérentes, sans promesse de disponibilité permanente.

### M4 — Exploitation minimale

- [ ] Un seul appel d'outil actif ; `busy` si le créneau est occupé **au moment de l'admission**, sans file applicative supplémentaire. Ne pas promettre une réponse immédiate ou rejeter rétrospectivement tout appel arrivé pendant un calcul bloquant.
- [ ] Documenter l'absence de timeout applicatif garanti : tailles bornées ≠ durée SQL bornée ; timeout/déconnexion client ≠ arrêt du calcul ; pas de fausse annulation par `Promise.race`.
- [ ] Aucune lecture directe des shards pour search/read ; status peut consulter l'état et la disponibilité des sources, sans ingérer leur contenu. Aucune réparation, indexation ou ingestion par le MCP.
- [ ] Lancement, arrêt et reprise manuels ; fermeture des connexions à l'arrêt normal, aucun travail détaché survivant ; pas de service automatique.

## Validation MVP (contribue au jalon J-MCP)

- [ ] Fixtures : catalogue fermé, entrées invalides, limites ajustées, budgets, totaux inconnus, erreurs sans contenu privé, search → read.
- [ ] Search : plus de 50 correspondances et scores égaux multi-sources, résultat top-k stable, filtre source/titres exact, aucune pagination ni faux curseur, réduction sous budget explicite.
- [ ] Read : plus de 200 messages, message de 60 000 caractères, accents/emoji et coupure par budget ; recollement intégral sans trou/doublon/caractère perdu ; curseur final absent, génération changée refusée. Ces tests ne sont pas reportés.
- [ ] Fidélité visible : recherche mixte/titre pi seul, search sans pi rendu, read pi initial/continué/vide à l'ancre ; signal pi structuré présent seulement dans les réponses concernées, budget respecté, pas de qualification erronée d'opencode ni de promesse de reconstruction ; descriptions search/read explicites.
- [ ] Parité temporelle CLI/MCP : ancre pi complète, ancre d'autre session, UTC, dates invalides/vides/inconnues, masquage avant fenêtre et comptes exacts ; la continuation ne réintroduit pas le futur.
- [ ] Fraîcheur : source absente mais archivée ; vue absente/périmée ; divergence pi refusée jusqu'à réparation ; cas opencode COMMIT avant état lisible si fraîcheur établie ; rejeu réussi => données et ordre identiques.
- [ ] Admission mono-travail : aucune exécution simultanée ; `busy` quand le gestionnaire observe un créneau occupé ; le test ne suppose pas une réponse immédiate pendant SQLite synchrone. Arrêt/reprise sans travail détaché et archive inchangée.
- [ ] Confidentialité : descriptions présentes ; Host/Origin et token vérifiés, aucun egress ; corpus/index/base source inchangés, journaux sans query/contenu/token/curseur ; appel raw ou fichier libre impossible.
- [ ] Client MCP réel sur PC : initialisation, catalogue, recherche, lecture complète par fragments, statut, reconnexion ; consigner client/version, volume testé, temps et limites. Compléter le lot B de scale-corpus ; corpus privé et détails sensibles hors Git.
- [ ] Tests de régression et validation OpenSpec. Pas de rejeu du jeu naturel gelé sans demande. Ne marquer le MVP livré qu'après validation effective.

## Extensions possibles, hors jalon (selon usage et nouvel accord)

- [ ] Pagination search si l'affinage top-k s'avère insuffisant : définir reprise et ordre sans dupliquer le scoring.
- [ ] Raw MCP : spécifier/valider les garde-fous D9, activation explicite, validation partId avant chemin, confinement, refus des orphelins, budgets et continuation liée au fichier, `unvetted`, avertissement de publication. Tests de preuve >65 536 octets, recollement exact, substitutions/liens/fichiers spéciaux, désactivation et journaux.
- [ ] Timeout strict et concurrence >1 si nécessaires : unité de travail isolable, arrêt demandé et observé sur SQLite natif, pas de résultat partiel, créneau conservé jusqu'à arrêt, pas de résultat tardif ni travail orphelin ; tester échec d'arrêt et saturation.
- [ ] Supervision/Agora : décision propriétaire distincte, sans lien obligatoire avec les extensions précédentes.
