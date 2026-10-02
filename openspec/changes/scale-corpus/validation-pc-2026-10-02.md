# Validation PC partielle — 02/10/2026

**J-MCP NON atteint ; aucun change clos ou archivé.** Ce bilan complète les validations historiques, sans les remplacer. Données privées et archives de validation hors Git.

## Environnement et contrôles ciblés

Linux PC, Node `26.8.1`, `better-sqlite3` `13.0.3`. Le module natif et FTS5 fonctionnent en mémoire (worker puis contrôle indépendant du principal). La dépendance SQLite est conservée ; aucune migration ni installation effectuée.

| Commande | Résultat worker | Durée observée |
|---|---|---|
| `node --test test/lock-concurrency.test.js` | 15/15 | 7,0 s |
| `node --test test/crash-real.test.js` | 17/17 | 3,4 s |
| `node --test test/snapshot-real.test.js` | 9/9 | 24,6 s |
| `node --test test/pi-adapter.test.js` après correctif | 43/43 | 0,3 s |

Le principal a contrôlé les sorties des trois premières campagnes et rejoué les 43 tests Pi (43/43, environ 0,2 s). Fixtures synthétiques temporaires uniquement pour ces tests. Pas de suite complète ni de rejeu du jeu naturel gelé. Les interruptions de processus ne simulent pas une panne matérielle. Durées d'exécution observées, pas des garanties ni un banc RSS/cache froid.

## Import Pi : défaut de découverte corrigé

La première ingestion a échoué : sept transcriptions de sous-agents et un journal de permissions sous `subagent-artifacts/` ne suivent pas le format des sessions Pi. Aucun événement publié ; archive de test laissée avec marqueur/verrou.

Correctif ciblé dans `src/adapter/pi.js` : ne pas descendre dans les répertoires nommés exactement `subagent-artifacts`, à toute profondeur. Aucun filtre général sur les fichiers invalides ; un fichier ordinaire `subagent-artifacts.jsonl` reste découvert. Deux tests ajoutés dans `test/pi-adapter.test.js` couvrent le sous-arbre ignoré, les sessions voisines et le refus d'un JSONL invalide hors du sous-arbre.

Après consentement distinct et vérifications du chemin, de son contenu et de l'arrêt de l'import, le principal a supprimé uniquement l'archive de test échouée. Le worker, dont la policy refusait la suppression, n'a pas contourné ce refus. Nouvelle ingestion réussie sur archive dédiée :

- 275 sessions, 8 402 événements, 8 637 fichiers de preuve ; durée 4,5 s.
- 13 exécutions `bashExecution` non rattachées, comptées ; pas d'erreur d'import.
- `status` contrôlé par le principal ; marqueur d'ingestion absent et vue publiée.
- Sources originales en lecture seule. Les sessions Pi actives avaient déjà évolué au contrôle suivant : pas de snapshot figé garanti, aucune seconde ingestion effectuée.

## Import OpenCode : première passe réelle

Commande CLI `ingest --source opencode --db <source> --home <archive-dediee>`, sur une archive distincte de Pi, source en lecture seule.

- Base observée : 5 985 054 720 octets ; WAL : 253 841 472 octets.
- 2 054 sessions, 79 030 événements, 87 850 fichiers de preuve ; durée 63,5 s, exit 0.
- Archive produite : environ 552 Mo (mesure worker) ; source beaucoup plus grosse que le contenu canonique retenu.
- `status` et absence du marqueur confirmés par le principal ; aucun mélange avec Pi.

Aucun delta, passe sans changement ou rebuild de cette archive réelle exécuté. Pas de mesure RSS maximale, plan SQL, cache froid/chaud ni garantie de snapshot unique de la source pendant l'import. Les sources actives peuvent évoluer après lecture.

## Validation d'usage CLI : portée exacte

Sur Pi, deux questions naturelles ont été résolues par le CLI uniquement : recherche, puis lecture du contexte. Elles portent sur une décision d'usage de l'interface Web et les fournisseurs suivis dans une extension personnelle. Aucun contenu de réponse privé publié ici.

Sur OpenCode, une question demandait le premier modèle utilisé et la première demande de configuration. Le principal a d'abord interrogé directement l'index dérivé en SQL : **ce passage ne constitue pas une validation du CLI**. La reprise a utilisé uniquement les commandes CLI (`search`, filtres `--source`, `--role`, `--before`, puis `read --at`/`--around`), six commandes en environ 0,8 s. Les traces ont été confirmées, mais les dates étaient déjà connues du passage SQL : test non indépendant.

**Besoin à prévoir, pas une fonctionnalité livrée ni une spec nouvelle : tri chronologique / identification des premières sessions ou messages via CLI.** Les dates existent ; la recherche classe par pertinence. Les filtres temporels et la lecture d'une session permettent de confirmer une trace, pas de prouver à eux seuls une première occurrence globale exhaustive. La conception de cette capacité nécessite un accord ultérieur.

## MCP : revue et reproduction ciblée

Revue statique par l'advisor, sans tests ni changement : aucune anomalie critique de confidentialité/sécurité trouvée ; ce constat n'est pas une garantie ni une validation cliente. Un défaut de lecture a été identifié puis reproduit par le worker avec le **vrai `createReadHandler`**, sans transport HTTP, SDK, mock ou copie modifiée du handler.

Fixture Pi temporaire : deux sessions, commande courte de contrôle et commande synthétique de 614 400 caractères ASCII (600 Kio), suivie d'un message ordinaire. Budget de réponse : 524 288 octets.

| Lecture directe du handler | Observation |
|---|---|
| Commande courte, lecture complète | Succès, deux messages |
| Commande longue, lecture complète, avec ou sans `full` | `internal` / `budget_exhausted` |
| Fenêtre ciblant le message à commande longue | Même refus |
| Fenêtre ciblant le message suivant, ou `tail:1` | Succès |

Aucun message ni curseur de continuation rendu lors du refus de lecture complète. Le texte est fragmenté, mais `toolCalls.cmd` reste entier : `FRAGMENT_SQL` extrait tous les appels et `pickFragment` ne réduit que le texte (`src/mcp/read.js`). Le principal a contrôlé les sorties brutes et le code. **Défaut confirmé, NON corrigé ; lecture complète sans perte NON validée pour ce cas.** Le script de reproduction inline et les fixtures ont été temporaires : pas encore de test de régression durable dans le dépôt.

La reproduction concerne Pi. L'affirmation initiale du worker selon laquelle OpenCode tronque toutes les commandes à 200 caractères était inexacte : `cmdFromInput` conserve notamment `input.command` intégralement. L'immunité OpenCode n'est donc pas établie ; reproduction OpenCode distincte non effectuée.

Le SDK `@modelcontextprotocol/sdk` et `zod` sont déclarés/verrouillés mais absents de `node_modules` sur ce PC (contrôle principal). Aucun besoin de ces modules pour le handler testé directement. L'utilisateur reporte leur installation au test du serveur MCP. Pas de client MCP réel, de tests de transport ou de suite MCP actuelle.

## Reprise : prochaines décisions

1. Choisir un traitement sans perte des commandes d'outil volumineuses, puis autoriser un correctif et un test durable. Ne pas remplacer silencieusement la promesse de lecture complète par un aperçu tronqué.
2. À l'étape MCP, installer les dépendances locales sur accord et tester le serveur/client réel, avec pagination et confidentialité. Aucune installation ni configuration client faite ici.
3. Compléter le lot B : delta, passe sans changement, reconstruction depuis archive et mesures restantes, avant toute clôture.
4. Prévoir le tri chronologique CLI ; besoin consigné, conception/implémentation non autorisées.

Les archives restent locales ; leurs chemins opérationnels sont consignés dans la note privée de reprise. Aucune permission de correction MCP, installation, nouvelle ingestion ou archivage n'est implicite dans ce bilan.
