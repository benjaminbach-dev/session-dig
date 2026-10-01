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
