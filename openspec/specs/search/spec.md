# Recherche de sessions (BM25)

## Purpose

Retrouver rapidement des messages passés à partir de mots-clés et de filtres structurés, sans modèle ni réseau en v0. L'architecture SHALL préparer l'ajout d'autres retrievers (embeddings) et d'une fusion hybride sans réécriture du cœur : le retriever FTS5 est le premier maillon, pas une architecture fermée.
## Requirements
### Requirement: Interface Retriever

Tout retriever SHALL implémenter une interface unique : `name`, `index(corpus)`, `search(query)` retournant une liste de hits `{eventId, score}`. Décision du 20/09 (change `scale-corpus`, contrainte d'échelle) : l'indexation opère **depuis le corpus en flux** (racine du corpus, ou itérateur borné fourni par le cœur) — l'interface ne permet plus de forcer le chargement complet du corpus en mémoire (l'ancienne signature `index(events)` sur tableau matérialisé est retirée). Tout retriever SHALL passer la suite contractuelle commune : (1) si un événement E est indexé, une requête composée de mots présents dans son texte doit retourner E ; (2) l'indexation est idempotente ; (3) l'index est entièrement reconstruisable depuis le seul corpus. Cette interface est la couture d'extension du projet : v0 n'active que le retriever `bm25`, mais aucune évolution ultérieure ne contournera l'interface.

#### Scenario: Contrat respecté

- **WHEN** un nouveau retriever est proposé
- **THEN** il passe la suite contractuelle commune avant toute intégration, sans exception ni test ad hoc.

#### Scenario: Index jetable

- **WHEN** l'index d'un retriever est supprimé
- **THEN** une réindexation depuis le seul corpus le reconstitue sans perte d'information permanente.

#### Scenario: Indexation en flux

- **WHEN** un corpus de plusieurs millions d'événements est indexé
- **THEN** l'indexation s'exécute en flux, sans matérialiser le corpus en mémoire, et produit le même index qu'une reconstruction complète depuis la même source.

### Requirement: Index FTS5 BM25

Le retriever `bm25` SHALL utiliser une base SQLite distincte du corpus via `better-sqlite3`, avec une table FTS5 en tokenizer unicode par défaut. Par défaut, l'index SHALL indexer le texte des messages `user` et `assistant` ET les commandes du champ `toolCalls[].cmd`, mais PAS les sorties d'outils (décision du 15/09 : les sorties volumineuses sont du bruit BM25 ; la ligne de commande est du signal pur). L'index SHALL également indexer le titre de chaque session : une ligne synthétique par session (id = id de session, `role: title` — décision du 17/09 motivée par l'évaluation, les titres générés par la source étant des résumés à fort signal de rappel). Les filtres structurés (`repo`, `session`, `ts`, `model`, `role`, `agent`) SHALL être des colonnes filtrables de l'index, pas des termes de requête.

Décisions du 17/09 (motivées par l'évaluation sur questions réelles) : les requêtes SHALL retirer une liste compacte de stopwords fr+en ; les jetons contenant un point (ex. `chutes.ai`) SHALL être traités comme des phrases FTS5 (tokens adjacents) ; la combinaison de termes SHALL être une disjonction pondérée BM25 (OR) — l'AND strict laissait gagner des messages « fourre-tout » contenant tous les termes (dump de configuration) contre la réponse attendue, tandis qu'en disjonction un événement matchant tous les termes cumule ses poids et sort naturellement en tête.

#### Scenario: Bruit évité

- **WHEN** une requête cible un sujet technique
- **THEN** les hits proviennent des textes de messages et des commandes exécutées, jamais des sorties d'outils volumineuses.

#### Scenario: Titre comme signal de rappel

- **WHEN** le vocabulaire discriminant d'une session vit surtout dans son titre (ex. « Mécanisme compaction opencode »)
- **THEN** la ligne `title` matche et fait remonter la session, même si aucun message ne contient tous les termes de la requête.

#### Scenario: Message fourre-tout

- **WHEN** un long message de configuration contient tous les termes de la requête sans être la réponse attendue
- **THEN** la disjonction pondérée par IDF privilégie l'événement portant le terme rare, sans recours à un AND strict.

#### Scenario: Bruit évité

- **WHEN** une requête cible un sujet technique
- **THEN** les hits proviennent des textes de messages et des commandes exécutées, jamais des sorties d'outils volumineuses.

#### Scenario: Filtre et recherche combinés

- **WHEN** une requête porte des mots-clés et un filtre `--repo ccp-proxy --after 2026-06-01`
- **THEN** seuls les événements du repo et de la période donnée sont candidats, et le classement BM25 s'applique à ce sous-ensemble.

### Requirement: CLI sdig

L'exécutable SHALL s'appeler `sdig` (le nom `dig` étant déjà pris par l'outil DNS). Usage : `sdig "requête" [--sort relevance|oldest|newest] [--repo R] [--session S] [--source S] [--after DATE] [--before DATE] [--model M] [--role R] [--agent A] [--limit N]`. La sortie SHALL afficher pour chaque hit : score, date, repo, id de session, rôle et un extrait avec termes surlignés. Les hits SHALL être regroupés par session à l'affichage (décision du 15/09 : le regroupement est une décision d'affichage, gratuite et réversible, le grain d'index restant le message) ; le tri interne reste le score **en mode `relevance` (défaut)**. Une option `--json` SHALL exposer les résultats bruts pour script et tests.

Le filtre `--source` SHALL filtrer sur le champ `source` des événements et sessions (correspondance exacte, ex. `opencode`, `pi`) ; les lignes de titre synthétiques portent la source de leur session et sont filtrées comme les messages. Cette provenance SHALL être identique que la ligne de titre soit créée ou mise à jour par ingestion incrémentale, ou reconstruite depuis le corpus ; pour une session héritée sans champ `source`, elle est interprétée comme `opencode`. La valeur du titre pi provient prioritairement de la dernière `session_info.name` non vide, sinon du repli défini par l'adaptateur ; le filtre ne dépend pas de l'origine de cette valeur. Une source inconnue produit zéro résultat, pas une erreur — y compris combinée à `--raw` : aucune preuve n'est alors parcourue. Combiné à `--raw`, le filtre `--source` borne aussi le scan des preuves : seules les sorties brutes de la source sélectionnée sont parcourues (les `partId` pi étant préfixés `pi:`, la sélection est déterministe, sans lecture des preuves des autres sources). Le partId fourni à `sdig raw <partId>` est une entrée non fiable : il SHALL être validé avant toute dérivation de chemin (familles connues opencode et `pi:<sessionId>:<id local>`, refus des séparateurs de chemin, de la traversée `..` et des ids vides), et la lecture est confinée au répertoire `raw/` — tout partId hostile est refusé, jamais interprété comme un chemin.

Décision du 02/10/2026 (change `add-cli-chronological-sort`) : l'option `--sort` SHALL accepter `relevance` (défaut, comportement BM25 actuel strictement inchangé), `oldest` et `newest`. **Option omise** : le mode `relevance` s'applique — avec une requête fournie, `sdig "requête"` reste inchangé. **Option présente sans valeur** (`--sort` en fin d'arguments, ou suivi d'une autre option comme `--sort --limit 1`) SHALL échouer par une erreur de valeur manquante, sans consommer l'option suivante ; une valeur inconnue SHALL échouer explicitement. En mode chronologique, la requête en mots-clés MAY être omise (exigence « Recherche chronologique sans mots-clés ») ; `--sort relevance` sans requête SHALL échouer par une erreur explicite, et l'absence totale d'argument SHALL conserver l'aide existante. `--sort` SHALL être refusé par les sous-commandes `ingest`, `read`, `raw`, `index`, `refresh`, `status`, `migrate`, `fingerprint` et `mcp`, même avec une valeur valide ; pour `mcp`, le parser reste DÉDIÉ et FERMÉ : le refus est un message FIXE qui ne recopie ni l'argument ni sa valeur, sans changement du parser MCP ni de l'API. Le rendu humain et le JSON des résultats chronologiques SHALL respecter l'ordre global défini par les exigences « Tri chronologique de la recherche », « Portée et honnêteté du tri chronologique » et « Affichage et métadonnées du tri chronologique ».

Les sous-commandes de lecture (`sdig read <session>`) SHALL documenter leurs options dans l'aide du CLI : `--around <msgId>`, `--ctx N`, `--tail N`, `--full`, `--chars N` et `--at <msgId|horodatage>` (exigence « Ancrage temporel à l'instant de l'ancre »). L'identifiant complet de session, préfixe de source compris (ex. `pi:<uuid>`), est l'adresse canonique pour `read` ; `--session` accepte l'identifiant complet ou un préfixe de celui-ci (comportement préfixe inchangé par ailleurs). Toute option non reconnue SHALL produire une erreur explicite plutôt que d'être ignorée silencieusement.

#### Scenario: Requête dorée

- **WHEN** `sdig "bug proxy"` est exécuté sur le corpus fixture
- **THEN** la session contenant le fix attendu apparaît en premier, avec l'extrait surligné.

#### Scenario: Regroupement par session

- **WHEN** plusieurs hits appartiennent à la même session en mode `relevance` (défaut)
- **THEN** ils sont affichés sous un en-tête de session commun, ordonnés chronologiquement dans le groupe.

#### Scenario: Sortie JSON

- **WHEN** `--json` est passé
- **THEN** la sortie est un JSON valide contenant les hits complets, sans décor de TUI.

#### Scenario: Filtre par source

- **WHEN** `sdig "requête" --source pi` est exécuté sur un corpus multi-source
- **THEN** seuls les hits des sessions pi sont retournés, y compris leurs lignes de titre ; les sessions des autres sources sont exclues.

#### Scenario: Filtre par source et preuves brutes

- **WHEN** `sdig "requête" --source pi --raw` est exécuté
- **THEN** le scan des sorties brutes ne parcourt que les preuves pi ; les preuves des autres sources ne sont ni lues ni retournées.

#### Scenario: Lecture d'une session préfixée

- **WHEN** `sdig read pi:<uuid>` est exécuté
- **THEN** la session pi correspondante est déroulée avec la même sémantique que toute autre session.

#### Scenario: Option inconnue

- **WHEN** une option non reconnue est passée à une sous-commande
- **THEN** le CLI échoue avec un message nommant l'option, au lieu de consommer silencieusement l'argument suivant ; exception : `sdig mcp` (parser dédié fermé) rend un message FIXE sans recopier l'argument ni sa valeur — la confidentialité prime, sans changement du parser MCP ni de l'API.

#### Scenario: Tri chronologique demandé

- **WHEN** `sdig "requête" --sort oldest` (ou `--sort newest`) est exécuté
- **THEN** les hits sont sélectionnés sur l'ensemble des matches filtrés puis ordonnés chronologiquement de façon globale, le mode et le sens étant affichés sans les confondre avec un score.

#### Scenario: Valeur de tri présente sans valeur ou invalide

- **WHEN** `--sort` est présent sans valeur (fin d'arguments, ou suivi d'une autre option comme `--sort --limit 1`) ou porte une valeur inconnue
- **THEN** le CLI échoue par une erreur nommant `--sort` et le motif, sans consommer l'option suivante ni retomber silencieusement sur `relevance` ; l'option omise, elle, laisse `relevance` s'appliquer quand une requête est fournie.

#### Scenario: Option de tri hors recherche

- **WHEN** `--sort newest` est passé à une sous-commande (`sdig read … --sort newest`, `sdig ingest --sort oldest`, `sdig status --sort relevance`) ou `--sort oldest` à `sdig mcp`
- **THEN** le CLI échoue explicitement ; `read`/`ingest`/`status` peuvent nommer `--sort` et sa valeur d'énumération, tandis que `mcp` (parser dédié fermé) rend un message FIXE sans recopier l'argument ni sa valeur, sans changement du parser MCP ni de l'API.

#### Scenario: Requête absente avec tri de pertinence

- **WHEN** `sdig --sort relevance` (option présente) est exécuté sans requête
- **THEN** le CLI échoue par une erreur explicite, sans inventer de requête `'*'` ni déverser l'archive ; option omise et aucun argument, l'aide existante demeure.

### Requirement: Performance

L'indexation complète d'un corpus d'environ 5 000 messages SHOULD s'exécuter en quelques secondes ; une requête SHOULD répondre en moins de 100 ms à cette échelle. Décision du 20/09 (change `scale-corpus`, resserrée sur retour du soir) : ces bornes sont re-visées à l'échelle et vérifiées sur un **banc synthétique déterministe** commis dans le dépôt, hors `npm test`. Le banc mesure **le parcours utilisateur complet, pas la seule couche FTS5** : recherche avec rendu groupé par session et voisins (`--ctx`) ; lecture de session avec ancrage `--at` et compteurs exacts ; ingestion initiale et delta depuis une **base source synthétique reprenant la structure réelle d'opencode.db** (mêmes tables, mêmes colonnes) ; lecture de preuve volumineuse. Les conditions de mesure sont consignées : machine, cache chaud/froid (mesures répétées), RSS maximale, espace disque temporaire. **Le banc est un instrument conditionnel (lot C du jalon MCP commun) : fidélité d'abord (rendu réellement mesuré, grosse preuve générée, RSS maximale prise), mesures d'échelle ensuite ; les objectifs p95 restent des cibles justifiées et non un prérequis universel** du premier jalon d'usage solo local sur PC. Cibles de conception : recherche p95 < 100 ms sur 500 000 événements (parcours complet rendu) ; lecture `--at` avec compteurs p95 < 100 ms sur une session de 10 000 messages ; delta d'ingestion de 1 000 événements < 10 s sur un corpus d'un million d'événements ; reconstruction complète du banc < 5 minutes ; empreinte mémoire < 512 Mo pour toute opération du banc. Ces bornes restent des cibles de conception, pas des garanties contractuelles ; si le lot C est entrepris, elles SHALL être vérifiées avec un instrument fidèle et ajustées avec justification si la mesure les contredit. Leur validation intégrale ne conditionne pas J-MCP : le lot B SHALL mesurer d'abord l'usage CLI/MCP sur le volume PC réellement observé et consigner ses limites.

#### Scenario: Volumétrie réelle

- **WHEN** le corpus PC est ingéré et sa vue construite pour la première validation
- **THEN** volumes réels, ingestion initiale/delta, recherche avec contexte, lecture avec ancrage et reconstruction sont vérifiés ; temps, mémoire, disque et limites de mesure sont consignés. Seuls les résultats non sensibles peuvent entrer dans le dépôt. Un écart à une cible de performance est arbitré explicitement, pas transformé en garantie ni en blocage universel du MVP.

#### Scenario: Banc synthétique à l'échelle

- **WHEN** le banc étendu (ancien objectif 100×) est exécuté dans le lot C (recherche rendue, lecture `--at`, ingestion depuis la base synthétique, preuve volumineuse)
- **THEN** les mesures p50/p95, la RSS maximale et les conditions (machine, cache, disque) sont consignées dans le dépôt, et tout écart aux cibles est documenté et arbitré (cible ajustée avec justification, ou implémentation corrigée).

### Requirement: Requêtes dorées et tests

Le dépôt SHALL commiter un corpus fixture synthétique et un jeu de requêtes dorées : chaque requête dorée spécifie le texte recherché, les filtres éventuels et la session attendue en tête de résultats. Toute évolution du scoring, du schéma ou de l'indexation qui rétrograde une requête dorée SHALL être détectée par les tests automatisés avant fusion.

#### Scenario: Régression de scoring

- **WHEN** une modification du scoring fait chuter la session attendue hors de la première position d'une requête dorée
- **THEN** le test échoue et la modification est corrigée ou la dorée est explicitement mise à jour avec justification.

### Requirement: Fusion hybride préparée

Le design SHALL documenter la fusion par reciprocal rank fusion (RRF) des listes de hits de plusieurs retrievers. En v0, un seul retriever étant actif, la fusion se réduit à la liste unique ; l'activation d'un second retriever (embeddings, v1+) SHALL se faire sans modification du cœur ni du CLI au-delà de la configuration.

#### Scenario: Arrivée du second retriever

- **WHEN** le retriever embeddings est activé en v1, après constat d'écart lexical répété dans l'évaluation (décision du 16/09 : l'évaluation arbitre avant tout travail dessus)
- **THEN** le CLI et le format de sortie restent inchangés, seuls la configuration et les tests gagnent une entrée.

### Requirement: Lecture du contexte et accès à la preuve

Décision du 16/09 (retour d'agent) : retrouver un extrait n'est pas retrouver la solution — le message trouvé peut contenir une hypothèse abandonnée. Le CLI SHALL permettre, après une recherche : de lire les messages voisins d'un hit (`--ctx N` sur la recherche ; `sdig read <session> --around <msgId> [--ctx N] [--tail N]` pour dérouler une session), et de consulter la sortie d'outil brute associée à un appel (`sdig raw <partId>`, référencé par `rawRef` dans les résultats). Les voisins SHALL être rendus en ordre chronologique, les hits marqués, et les fenêtres de voisins de hits proches SHALL être fusionnées pour éviter les doublons d'affichage.

Décision du 19/09 (analyse du premier passage réel) : une coupure d'affichage silencieuse fait croire — à un agent comme à un humain — que l'archive ne contient pas la suite du message. Quand le rendu d'un message est tronqué, le CLI SHALL afficher un **marqueur de troncation** auto-suffisant : une mention explicite de limite d'affichage, les compteurs exacts (caractères affichés / caractères totaux du message) et le chemin vers le texte intégral (`--full`, `--chars N`, `sdig search --json`). L'option `--full` SHALL lever la limite d'affichage par message, l'option `--chars N` SHALL la fixer explicitement ; le format `--json` SHALL rester non tronqué. Un message rendu sans coupure SHALL produire aucun marqueur. Aucun message tronqué ne SHALL être rendu sans marqueur — dans `read` (messages, `--around`, `--ctx`, `--tail`) comme dans les hits groupés d'une recherche.

Décision du 20/09 (change `add-read-at`) : la lecture d'une session MAY être bornée dans le temps (`--at`, exigence « Ancrage temporel à l'instant de l'ancre »). Le **masquage temporel** et la **troncature d'affichage** sont deux signaux distincts, nommés distinctement, jamais confondus dans le rendu : le premier dit qu'on a cessé de lire, le second que le texte affiché est incomplet. Tous deux sont des filtres d'**affichage** : ils ne restreignent aucun accès, et `sdig raw <partId>` SHALL continuer de restituer la preuve intégrale, y compris pour un message masqué ou tronqué.

#### Scenario: Hypothèse abandonnée

- **WHEN** un hit est une hypothèse corrigée plus loin dans la session
- **THEN** `--ctx` ou `sdig read --around` montre les messages suivants qui infirment ou confirment, sans quitter la recherche.

#### Scenario: Preuve en sortie brute

- **WHEN** un toolCall affiche un `rawRef`
- **THEN** `sdig raw <partId>` restitue la sortie complète enregistrée dans `raw/`.

#### Scenario: Marqueur de troncation

- **WHEN** un message dépasse la limite d'affichage et qu'aucune option d'intégralité n'est donnée
- **THEN** la sortie affiche le marqueur avec les compteurs exacts et le chemin documenté vers le texte intégral — jamais une coupure silencieuse.

#### Scenario: Texte intégral à la demande

- **WHEN** la lecture est relancée avec `--full`
- **THEN** le message est rendu intégralement, sans marqueur ; avec `--chars N`, l'affichage est borné à N caractères et le marqueur s'applique si coupure il y a.

#### Scenario: JSON intégral

- **WHEN** la sortie est demandée en `--json`
- **THEN** les textes de messages sont rendus intégralement, indépendamment de la limite d'affichage humain.

#### Scenario: Deux signaux distincts

- **WHEN** une lecture bornée dans le temps affiche un message dont le texte est par ailleurs tronqué
- **THEN** le rendu porte le marqueur de troncature pour ce message et, séparément, le marqueur de masquage temporel de la vue — aucun des deux ne remplace l'autre.

#### Scenario: La preuve reste entière

- **WHEN** un message est masqué par une ancre temporelle (ou tronqué à l'affichage)
- **THEN** `sdig raw <partId>` restitue sa sortie d'outil intégrale : le masquage est un choix de lecture, pas un contrôle d'accès.

### Requirement: Recherche brute optionnelle

Les sorties d'outils restent exclues de l'index BM25 par défaut (décision du 15/09 : signal contre bruit). Le CLI SHALL offrir une recherche optionnelle par sous-chaîne dans `raw/` (`--raw`), car une erreur précise n'apparaît parfois que dans stderr. Cette recherche SHALL resituer chaque match (session, date, outil, commande) et rester bornée en résultats. Décision du 20/09 (change `scale-corpus`, resserrée sur retour du soir) : le scan s'exécute en **flux** — fichier par fichier, **par blocs bornés à l'intérieur de chaque fichier** (recouvrement aux frontières pour ne pas perdre un match à cheval) — et son coût O(volume de `raw/`) est documenté et annoncé : l'option reste opt-in, une opération consciente, jamais une surprise de durée ; l'empreinte mémoire ne dépend pas de la taille des fichiers.

#### Scenario: Erreur uniquement en stderr

- **WHEN** une requête avec `--raw` vise un message d'erreur absent des textes indexés
- **THEN** le match dans la sortie brute est listé avec sa session et sa commande, sans avoir été ajouté à l'index BM25.

#### Scenario: Scan en flux borné

- **WHEN** `--raw` est exécuté sur un `raw/` de plusieurs gigaoctets contenant des fichiers volumineux
- **THEN** le scan traite les fichiers par blocs sans charger l'archive ni les fichiers entiers, rend un résultat borné et affiche sa durée.

### Requirement: Évaluation sur recherches réelles

Décision du 16/09 (retour d'agent) : la pertinence se mesure sur des questions d'usage, pas seulement sur idempotence, contrats et performance. Le dépôt SHALL embarquer un harnais d'évaluation (`eval/queries.json` + runner `npm run eval`) et viser une vingtaine de questions issues de l'usage réel, chacune avec la session attendue. Les échecs SHALL être documentés comme écarts lexicaux connus plutôt que corrigés par retouches de scoring ; un manque répété est le signal qui arbitre l'activation des embeddings, avant tout travail dessus.

#### Scenario: Écart lexical documenté

- **WHEN** une question d'usage échoue en top-1 de façon répétée
- **THEN** l'échec est consigné dans le harnais comme écart connu et alimente la décision d'activer le retriever embeddings.

### Requirement: Ancrage temporel à l'instant de l'ancre (read --at)

Décision du 20/09 (analyse du premier passage réel et son rescopage) : sur une question d'état, la vérité terrain est l'état **à l'instant où la question a été posée**, pas l'état final de la session (4 dérives temporelles mesurées : n05, n44, n46, n50). Le CLI SHALL offrir, sur la lecture d'une session, l'option `--at <ancre>` qui masque les messages **postérieurs** à l'ancre, afin qu'un agent ou un humain puisse lire la session dans l'état où elle était à cet instant.

L'ancre SHALL accepter au minimum un identifiant de message de la session (`msg_…`) ; un horodatage explicite SHOULD être accepté (date, date et heure, ou millisecondes epoch). Les horodatages SHALL être interprétés en **UTC**, le référentiel de l'affichage des dates — afin qu'une même ancre produise la même vue quel que soit le fuseau du processus (défaut constaté le 20/09 : interprétation en heure locale face à un affichage UTC, d'où un décalage silencieux d'une heure ou plus). L'ancre résolue SHALL être **affichée** en tête de sortie, avec l'identifiant du message retenu et sa date, afin qu'une ancre erronée soit visible et non silencieuse. Les messages dont l'horodatage est **égal** à celui de l'ancre SHALL être visibles (inclusion).

Un horodatage SHALL être **calendairement valide** : une date inexistante (`2026-02-30`), une heure hors bornes (`25:00`), une minute ou une seconde hors bornes SHALL produire une erreur explicite nommant l'ancre, jamais un report silencieux au jour ou à l'heure suivante — le report automatique du calendrier est précisément le mode de défaillance que ce remède doit exclure (un décalage invisible d'un jour déplacerait la vue temporelle sans que rien ne le dise).

Une ancre **vide** (chaîne vide ou espaces) SHALL être refusée comme une ancre illisible : une variable d'environnement vide ou une substitution ratée ne doit pas réintroduire silencieusement la lecture non bornée de la session entière.

Le masquage SHALL être **explicite** : la sortie SHALL porter un marqueur indiquant le nombre de messages masqués, l'ancre appliquée, et le fait qu'une lecture sans `--at` montre la session entière. Aucun masquage silencieux ne SHALL être possible. Le masquage est un filtre d'affichage : `sdig raw <partId>` et l'archive restent intégralement accessibles.

L'ordre des opérations SHALL être fixé et documenté : le masquage temporel détermine d'abord la vue lisible, puis les options de fenêtrage (`--around <msgId>`, `--ctx N`, `--tail N`) s'appliquent **dans** cette vue. Une fenêtre qui ne contiendrait que des messages postérieurs à l'ancre SHALL produire un message explicite (le dire, avec l'ancre rappelée), jamais une sortie vide ambiguë. Une ancre illisible, vide, ou absente de la session SHALL produire une erreur explicite et un code de sortie non nul, sans sortie partielle trompeuse. Le format `--json` SHALL exposer l'ancre résolue et le nombre de messages masqués.

Sont **hors périmètre**, explicitement : la détection automatique des mutations d'état (savoir *ce qui* change à un instant donné), la reconstruction d'un état agrégé, et l'application de `--at` à la recherche (`sdig search` conserve ses filtres `--after`/`--before`, qui bornent la recherche sans masquer d'affichage).

#### Scenario: Lecture à l'instant de la question

- **WHEN** une session contient un message qui retire un outil à 11:38 et que la question date de 11:24
- **THEN** `sdig read <session> --at <msgId de 11:24>` montre les messages jusqu'à 11:24 inclus (l'outil encore présent) et masque les suivants, avec l'ancre et le compte masqué affichés.

#### Scenario: Masquage visible, jamais silencieux

- **WHEN** une lecture est bornée par `--at`
- **THEN** la sortie indique le nombre de messages masqués, l'ancre appliquée et le fait que la session entière se lit sans `--at`.

#### Scenario: Inclusion de l'instant exact

- **WHEN** un message porte exactement l'horodatage de l'ancre
- **THEN** il est visible dans la lecture bornée.

#### Scenario: Fenêtre entièrement postérieure

- **WHEN** `--at` est combiné à `--around` ou `--tail` et que la fenêtre demandée ne contient que des messages postérieurs à l'ancre
- **THEN** le CLI le dit explicitement en rappelant l'ancre, au lieu de rendre une sortie vide ou trompeuse.

#### Scenario: Ancre invalide

- **WHEN** l'ancre est un identifiant inconnu, un message d'une autre session, ou un horodatage illisible
- **THEN** le CLI échoue avec un message nommant l'ancre et le motif, et un code de sortie non nul.

#### Scenario: Date inexistante

- **WHEN** l'ancre est un horodatage calendairement impossible (`2026-02-30`)
- **THEN** le CLI échoue avec un message nommant la date, sans lecture non bornée ni report au 2 mars.

#### Scenario: Débordement d'heure

- **WHEN** l'ancre porte une heure, une minute ou une seconde hors bornes (`2026-09-05T25:00`, `2026-09-05T10:75`)
- **THEN** le CLI échoue avec un message nommant l'ancre, au lieu de basculer au lendemain ou à l'heure suivante.

#### Scenario: Ancre vide

- **WHEN** l'ancre est vide ou ne contient que des espaces (`--at ""`, cas typique d'une variable shell vide)
- **THEN** le CLI échoue avec une erreur explicite, au lieu d'afficher la session entière comme si l'option n'avait pas été donnée.

#### Scenario: Indépendance du fuseau

- **WHEN** la même ancre horodatée est résolue par deux processus dont le fuseau diffère (`TZ=UTC` et `TZ=Europe/Paris`)
- **THEN** l'horodatage résolu, l'ancre affichée et la vue bornée sont identiques.

#### Scenario: Ancre exposée en JSON

- **WHEN** la lecture bornée est demandée en `--json`
- **THEN** la sortie porte l'ancre résolue (identifiant, horodatage) et le nombre de messages masqués, exploitables par un script ou un harnais d'évaluation.

#### Scenario: Aucune détection de mutation

- **WHEN** la session contient une modification d'état antérieure à l'ancre
- **THEN** l'outil ne la signale pas et ne l'interprète pas : `--at` borne la lecture dans le temps, il ne prétend pas qualifier les changements d'état.

### Requirement: Limites de fidélité pi dans les résultats

Toute recherche rendant au moins un hit ou voisin pi (titre synthétique compris), et toute lecture d'une session pi connue, même vide à l'ancre, SHALL signaler dans sa réponse les deux limites de l'adaptateur actuel : branches aplaties par ordre temporel et éditions `context_edit` non appliquées. Le signal SHALL être visible dans le rendu terminal et exploitable par machine dans `--json`, sans texte hors JSON. Il SHALL être associé à la source pi, sans qualifier les résultats opencode de ces pertes.

Cet avertissement est une limite générale de l'adaptateur, pas la détection d'une branche abandonnée ou d'une édition dans la session rendue. Il SHALL ne pas présenter l'ordre temporel ni `--at` comme une reconstruction de la branche retenue ou du contexte effectif. Une recherche sans résultat pi SHALL ne pas émettre ce signal ; une session inconnue conserve son erreur habituelle. Aucun accès à la source, nouveau champ canonique ou calcul de parenté SHALL être requis pour ce signal. La reconstruction des branches et l'application des éditions restent hors périmètre.

#### Scenario: Recherche mixte avec titre pi

- **WHEN** une recherche rend des hits opencode et un titre pi, sans message pi
- **THEN** la réponse signale les deux limites pour la source pi, y compris en JSON valide, sans les attribuer aux hits opencode.

#### Scenario: Lecture pi ancrée et vide

- **WHEN** une session pi connue est lue avec `--at`, y compris si aucun message n'est visible
- **THEN** la réponse conserve l'ancre et ses compteurs et signale les deux limites, sans prétendre restituer la branche retenue ni appliquer les éditions.

#### Scenario: Aucune donnée pi rendue

- **WHEN** une recherche ne rend que des résultats opencode ou aucun résultat
- **THEN** elle n'émet pas d'avertissement de fidélité pi, même si le corpus contient des sessions pi.

### Requirement: Tri chronologique de la recherche

Le CLI SHALL offrir `--sort oldest|newest`. Ces modes SHALL sélectionner chronologiquement l'ENSEMBLE des événements qui matchent la requête et les filtres, puis ordonner et borner par `--limit` — jamais trier un top-k BM25 déjà réduit. Ils SHALL réutiliser la normalisation de requête existante (retrait des stopwords fr+en, tokenizer unicode, disjonction pondérée OR, jetons pointés traités comme phrases) et les mêmes filtres exacts `--repo --session --source --after --before --model --role --agent`. L'ordre SHALL être, en `oldest`, `(ts ASC, id COLLATE BINARY ASC)`, et en `newest`, `(ts DESC, id COLLATE BINARY DESC)` : comparaison sur l'epoch millisecondes (`ts` INTEGER), jamais sur une chaîne de date ; un `ts` à 0 (epoch) est valide ; les `ts` égaux SHALL être départagés par l'id canonique qualifié (ex. `pi:<sessionId>:<id>`) en ordre binaire, garantissant un ordre global déterministe sur plusieurs sources. Le score BM25 MAY rester disponible comme diagnostic, mais SHALL ne pas déterminer l'ordre chronologique. `--limit` SHALL valoir par défaut 20, être un entier positif, et s'appliquer APRÈS l'ordre.

#### Scenario: Premier match moins pertinent

- **WHEN** l'archive contient plus de N matches et que le plus ancien des matches n'appartient pas au top-N BM25
- **THEN** `--sort oldest --limit N` le rend en tête : la sélection a lieu sur tous les matches filtrés, pas sur le top-N de pertinence.

#### Scenario: Égalité de ts entre sources

- **WHEN** deux événements de deux sources distinctes portent le même `ts`
- **THEN** leur ordre est départagé par l'id canonique en ordre binaire, de façon stable et identique à chaque exécution.

#### Scenario: Filtre avant tri et limite

- **WHEN** des filtres (`--repo`, `--after`, `--model`, `--role`, `--source`…) réduisent la population
- **THEN** le tri chronologique et `--limit` s'appliquent à cette population filtrée, jamais à l'archive entière.

#### Scenario: Horodatage à l'epoch

- **WHEN** un événement porte `ts = 0`
- **THEN** il est ordonné sur sa valeur numérique (avant tout `ts` positif en `oldest`), sans être traité comme absent.

### Requirement: Recherche chronologique sans mots-clés

En mode chronologique explicite (`--sort oldest|newest`), la requête en mots-clés MAY être omise. **Une requête physiquement omise** n'est pas une requête fournie vide : une requête positionnelle fournie mais vide, en espaces, ou réduite à des stopwords ne SHALL PAS être transformée silencieusement en mode d'exploration — elle suit la normalisation existante (erreur `no_terms` ou zéro hit, comme aujourd'hui), la distinction portant sur la présence du token, pas sur son contenu.

Sans mots-clés, le CLI SHALL sélectionner l'ensemble des événements canoniques de l'archive courante : le sous-ensemble CANONIQUE est TOUJOURS l'intersection `role ∈ {user, assistant}` ∩ filtre `--role` éventuel ; `--role title` ou une valeur inconnue produit ZÉRO hit sans mots-clés — jamais l'inclusion d'une ligne `title`. Les lignes synthétiques `role: title` (artefact d'index, non un message) SHALL être exclues, et les sorties brutes ne SHALL jamais être déversées (`--raw` est refusé en chrono par l'exigence « Portée et honnêteté du tri chronologique »). Les événements à texte vide ou à commandes seules SHALL être inclus, contrairement à la recherche FTS qui exige un terme exploitable. Les filtres exacts (`--repo --session --source --after --before --model --role --agent`) SHALL s'appliquer inchangés. Le filtre `--source` porte sur la PROVENANCE ARCHIVÉE, pas sur la disponibilité actuelle : une source inconnue produit zéro hit, mais une source archivée dont la base d'origine a disparu du disque reste cherchable, sans aucune lecture de la source d'origine.

Une métadonnée de modèle absente SHALL ne pas être inventée : sans `--model`, tous les assistants sont candidats, y compris ceux dont le modèle est absent ; l'événement rendu porte explicitement `model: null` en JSON (jamais une valeur inventée), et la réponse SHALL signaler honnêtement la limite. L'avertissement SHALL être conditionnel — émis seulement si au moins un hit assistant RENDU a une métadonnée de modèle absente, jamais par un scan exhaustif de tous les assistants de l'archive, et pas en `--role user` où aucun assistant n'est rendu. En JSON, cet avertissement SHALL aller sur `stderr`, le `stdout` restant un unique tableau JSON sans texte hors tableau. `--model M` filtre les seuls événements portant ce modèle (sous-chaîne, comme en mode pertinence). Sans mots-clés, `--sort relevance` (ou l'absence de `--sort`) SHALL échouer par une erreur explicite ; l'absence totale d'argument conserve l'aide existante. L'usage documenté principal reste `sdig "requête" --sort oldest|newest` ; l'usage sans mots-clés vise les questions de première trace, par exemple `sdig --sort oldest --role assistant --model M --limit 1 --json`.

#### Scenario: Première trace avec modèle

- **WHEN** `sdig --sort oldest --role assistant --model M --limit 1 --json` est exécuté
- **THEN** il retourne le plus ancien événement assistant portant le modèle M dans le sous-ensemble filtré de l'archive courante, avec son `ts` minimal et son `id` qualifié.

#### Scenario: Sans modèle, réponse honnête

- **WHEN** aucun `--model` n'est fourni en mode chronologique sans mots-clés
- **THEN** tous les assistants sont candidats, y compris ceux dont la métadonnée de modèle est absente ; chaque événement rendu conserve son modèle connu ou porte `model: null` s'il est absent (jamais une valeur inventée), et l'avertissement n'est émis que si un hit assistant rendu a effectivement un modèle absent, sur `stderr` en JSON, jamais comme texte hors du tableau sur `stdout`.

#### Scenario: Modèle absent non signalé sur un rendu sans assistant

- **WHEN** `--role user` (aucun hit assistant) est rendu en mode chronologique sans mots-clés
- **THEN** aucun avertissement de modèle n'est émis : le signal est conditionnel aux hits assistants rendus, sans scan exhaustif de tous les assistants de l'archive.

#### Scenario: Requête fournie mais vide ou sans terme exploitable

- **WHEN** `sdig "" --sort oldest`, `sdig "   " --sort oldest` ou une requête en stopwords seuls (`sdig "le la de" --sort oldest`) est fournie explicitement
- **THEN** la normalisation existante s'applique (erreur `no_terms` ou zéro hit, comportement actuel) et le mode chronologique d'exploration n'est PAS activé silencieusement : seule l'omission physique de la requête donne le mode sans mots-clés.

#### Scenario: Source archivée absente du disque

- **WHEN** la base d'origine d'une source a disparu du disque mais ses événements sont archivés, et qu'un tri chronologique filtre sur cette source
- **THEN** les événements archivés restent cherchables et rendus (le filtre porte sur la provenance archivée, pas sur la disponibilité actuelle), sans aucune lecture de la source d'origine ; une source inconnue produit toujours zéro hit.

#### Scenario: Titre exclu sans mots-clés

- **WHEN** le mode chronologique est utilisé sans requête
- **THEN** aucune ligne `role: title` n'est retournée ; le CLI ne produit pas non plus une liste globale de sessions, chaque hit restant un événement borné par `--limit`.

#### Scenario: Texte vide ou commande seule inclus

- **WHEN** un événement canonique n'a pas de texte mais porte des commandes (`toolCalls[].cmd`)
- **THEN** il est candidat en mode chronologique sans mots-clés, alors que la recherche FTS l'exclurait faute de terme.

#### Scenario: Titre candidat avec mots-clés

- **WHEN** une recherche chronologique est faite AVEC mots-clés et qu'une ligne `role: title` matche
- **THEN** elle reste éligible comme aujourd'hui (compatibilité BM25) ; son `ts` provient des métadonnées de session et non d'une preuve d'occurrence, et les exemples visant la demande d'origine utilisent `--role user` ou `--role assistant`.

#### Scenario: Pertinence sans requête refusée

- **WHEN** `sdig --sort relevance` (ou l'absence de `--sort`) est utilisé sans requête
- **THEN** le CLI échoue par une erreur explicite, sans requête `'*'` inventée ni archive déversée sans limite.

### Requirement: Portée et honnêteté du tri chronologique

Le tri chronologique SHALL porter uniquement sur la commande de recherche du CLI. Il SHALL ne créer aucune sous-commande (en particulier aucune commande « sessions ») ni aucun outil MCP nouveau, et SHALL ne rien changer au curseur ni à la pagination MCP existants. `--raw` combiné à un mode chronologique SHALL être refusé par une erreur explicite (mélanger le classement FTS et le scan brut ne produirait pas un ordre global honnête) ; le mode `--raw` par défaut reste inchangé. `--at` reste propre à `read` ; la sémantique de `--after`/`--before` sur la recherche SHALL rester inchangée. Le classement SHALL réutiliser la vue courante et le snapshot de lecture seule existants, sans mutation implicite (aucune réparation d'index, réindexation ou relecture de source déclenchée) ; une vue absente ou périmée SHALL produire le refus existant, jamais une reconstruction silencieuse. Aucun index de source supplémentaire SHALL être créé. La sélection MAY lire les colonnes nécessaires et faire scanner SQL l'ensemble des matches : c'est un coût honnête, sans garantie de réponse sous 100 ms. Le CLI SHALL ne charger en mémoire que les lignes de résultat et le contexte demandé. Aucune pagination ni curseur chronologique n'est promis : `--limit` borne l'affichage, et une troncature n'est pas une exhaustivité. `--sort oldest --limit 1` SHALL rendre le plus ancien RECORD INDEXÉ du sous-ensemble filtré de l'archive COURANTE, pas le premier usage historique de l'outil. Sans mots-clés (ou avec `--role user|assistant`), ce plus ancien record est un MESSAGE ; AVEC mots-clés, le plus ancien record peut être une ligne `title`, qui n'est PAS une preuve de premier message — son `ts` provient des métadonnées de session et jamais d'une date de texte de message. Le tri SHALL distinguer les premiers MESSAGES des premières SESSIONS : la date de création d'une session n'est pas la date de son premier message, et l'ordre porte sur les événements.

#### Scenario: Sous-commandes refusées

- **WHEN** `sdig ingest --sort oldest`, `sdig read X --sort newest`, `sdig status --sort relevance` ou `sdig mcp --sort oldest` est exécuté
- **THEN** le CLI échoue explicitement en nommant `--sort` et la sous-commande ; une valeur valide ne dispense pas du refus.

#### Scenario: Chrono et raw refusés ensemble

- **WHEN** `sdig "requête" --sort oldest --raw` est exécuté
- **THEN** le CLI échoue explicitement, sans produire de faux ordre global mélangeant hits FTS et matches bruts.

#### Scenario: Vue absente ou périmée

- **WHEN** la vue est absente ou détectée en retard au moment d'un tri chronologique
- **THEN** le refus existant s'applique (`sdig refresh` requis), sans indexation, réparation ni lecture de source déclenchée implicitement.

#### Scenario: Troncature, pas exhaustivité

- **WHEN** `--limit N` est fourni
- **THEN** au plus N hits sont rendus, la réponse ne prétend pas à l'exhaustivité et aucun curseur ni page suivante n'est promis.

#### Scenario: Minimum du sous-ensemble courant

- **WHEN** `--sort oldest --limit 1` est exécuté
- **THEN** il rend le plus ancien record indexé du sous-ensemble filtré de l'archive courante, sans se présenter comme le premier usage historique de l'outil ; sans mots-clés (ou avec `--role user|assistant`) c'est un message, tandis qu'avec mots-clés une ligne `title` peut être ce record sans être une preuve de premier message.

#### Scenario: Messages et sessions distingués

- **WHEN** une session a été créée avant une autre mais que son premier message est postérieur
- **THEN** l'ordre chronologique suit le `ts` des messages (événements), jamais la date de création de la session.

### Requirement: Affichage et métadonnées du tri chronologique

En mode chronologique, l'affichage humain SHALL préserver l'ordre global : il SHALL ne pas regrouper les hits par session d'une manière qui rompe l'entrelacement (un rendu plat, une entrée par hit, est acceptable) et SHALL afficher le sens et le mode (`oldest`/`newest`, chronologique) pour qu'un score éventuel ne soit pas confondu avec l'ordre. Le format `--json` SHALL rester un TABLEAU de hits compatible (pas d'enveloppe `{hits: …}`), en conservant `ts` numérique, `id`, `sessionId`, `role`, `model` et le texte intégral ; `score` SHALL rester numérique en mode `relevance` (inchangé) et en mode chronologique AVEC mots-clés (score BM25 calculé pour chaque hit, jamais `undefined` ; sa valeur peut différer entre hits mais ne détermine pas leur ordre) ; seul le NOUVEAU mode chronologique SANS mots-clés MAY porter `score: null` — c'est un comportement de mode nouveau, pas un élargissement de type du mode `relevance`, qui reste strictement intact. Les voisins affichés par `--ctx` SHALL rester des voisins (jamais des candidats), en ordre chronologique, distincts des hits ; la déduplication des fenêtres de voisins SHALL ne pas modifier l'ordre ni le rang principal. `--ctx` reste une commodité d'affichage HUMAIN : le format `--json` continue de rendre les hits seuls (tableau), sans nouvelle clé `contexte`/`ctx`, les voisins n'étant pas des champs JSON.

#### Scenario: Entrelacement global préservé

- **WHEN** des hits de deux sessions alternent dans le temps
- **THEN** le rendu humain conserve l'ordre chronologique global (rendu plat par hit si nécessaire) au lieu d'un regroupement par session qui fausserait l'ordre.

#### Scenario: JSON resté tableau

- **WHEN** `--json` est demandé en mode chronologique
- **THEN** la sortie reste un tableau de hits au même format, `ts` numérique et texte intégral ; avec mots-clés, `score` est numérique (diagnostic BM25 calculé par hit) comme en `relevance`, et sans mots-clés il peut être `null` sans être inventé ; `--ctx` n'ajoute aucune clé au JSON, qui rend les hits seuls.

#### Scenario: Voisins non candidats

- **WHEN** `--ctx N` accompagne un tri chronologique
- **THEN** les voisins sont rendus comme voisins, ne comptent pas comme hits et ne modifient ni l'ordre ni le rang principal.

#### Scenario: Sens du tri affiché

- **WHEN** un tri chronologique est rendu
- **THEN** le mode et le sens (`oldest`/`newest`) sont affichés, de sorte qu'un score diagnostique éventuel ne soit pas pris pour l'ordre.
