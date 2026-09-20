# Recherche de sessions (BM25)

## Purpose

Retrouver rapidement des messages passés à partir de mots-clés et de filtres structurés, sans modèle ni réseau en v0. L'architecture SHALL préparer l'ajout d'autres retrievers (embeddings) et d'une fusion hybride sans réécriture du cœur : le retriever FTS5 est le premier maillon, pas une architecture fermée.

## Requirements

### Requirement: Interface Retriever

Tout retriever SHALL implémenter une interface unique : `name`, `index(events)`, `search(query)` retournant une liste de hits `{eventId, score}`. Tout retriever SHALL passer la suite contractuelle commune : (1) si un événement E est indexé, une requête composée de mots présents dans son texte doit retourner E ; (2) l'indexation est idempotente ; (3) l'index est entièrement reconstruisable depuis le seul corpus. Cette interface est la couture d'extension du projet : v0 n'active que le retriever `bm25`, mais aucune évolution ultérieure ne contournera l'interface.

#### Scenario: Contrat respecté

- **WHEN** un nouveau retriever est proposé
- **THEN** il passe la suite contractuelle commune avant toute intégration, sans exception ni test ad hoc.

#### Scenario: Index jetable

- **WHEN** l'index d'un retriever est supprimé
- **THEN** une réindexation depuis le seul corpus le reconstitue sans perte d'information permanente.

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

L'exécutable SHALL s'appeler `sdig` (le nom `dig` étant déjà pris par l'outil DNS). Usage : `sdig "requête" [--repo R] [--session S] [--after DATE] [--before DATE] [--model M] [--role R] [--agent A] [--limit N]`. La sortie SHALL afficher pour chaque hit : score, date, repo, id de session, rôle et un extrait avec termes surlignés. Les hits SHALL être regroupés par session à l'affichage (décision du 15/09 : le regroupement est une décision d'affichage, gratuite et réversible, le grain d'index restant le message) ; le tri interne reste le score. Une option `--json` SHALL exposer les résultats bruts pour script et tests.

Les sous-commandes de lecture (`sdig read <session>`) SHALL documenter leurs options dans l'aide du CLI : `--around <msgId>`, `--ctx N`, `--tail N`, `--full`, `--chars N` et `--at <msgId|horodatage>` (exigence « Ancrage temporel à l'instant de l'ancre »). Toute option non reconnue SHALL produire une erreur explicite plutôt que d'être ignorée silencieusement.

#### Scenario: Requête dorée

- **WHEN** `sdig "bug proxy"` est exécuté sur le corpus fixture
- **THEN** la session contenant le fix attendu apparaît en premier, avec l'extrait surligné.

#### Scenario: Regroupement par session

- **WHEN** plusieurs hits appartiennent à la même session
- **THEN** ils sont affichés sous un en-tête de session commun, ordonnés chronologiquement dans le groupe.

#### Scenario: Sortie JSON

- **WHEN** `--json` est passé
- **THEN** la sortie est un JSON valide contenant les hits complets, sans décor de TUI.

#### Scenario: Option inconnue

- **WHEN** une option non reconnue est passée à une sous-commande
- **THEN** le CLI échoue avec un message nommant l'option, au lieu de consommer silencieusement l'argument suivant.

### Requirement: Performance

L'indexation complète d'un corpus d'environ 5 000 messages SHOULD s'exécuter en quelques secondes ; une requête SHOULD répondre en moins de 100 ms à cette échelle. Ces bornes sont des cibles de conception, pas des garanties contractuelles ; elles SHALL être vérifiées par un test de performance au moment de l'implémentation et ajustées si nécessaire.

#### Scenario: Volumétrie réelle

- **WHEN** le corpus réel (~5 000 messages) est indexé
- **THEN** la durée est mesurée et consignée dans le dépôt, et la requête type reste sous la cible.

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

Les sorties d'outils restent exclues de l'index BM25 par défaut (décision du 15/09 : signal contre bruit). Le CLI SHALL offrir une recherche optionnelle par sous-chaîne dans `raw/` (`--raw`), car une erreur précise n'apparaît parfois que dans stderr. Cette recherche SHALL resituer chaque match (session, date, outil, commande) et rester bornée en résultats.

#### Scenario: Erreur uniquement en stderr

- **WHEN** une requête avec `--raw` vise un message d'erreur absent des textes indexés
- **THEN** le match dans la sortie brute est listé avec sa session et sa commande, sans avoir été ajouté à l'index BM25.

### Requirement: Évaluation sur recherches réelles

Décision du 16/09 (retour d'agent) : la pertinence se mesure sur des questions d'usage, pas seulement sur idempotence, contrats et performance. Le dépôt SHALL embarquer un harnais d'évaluation (`eval/queries.json` + runner `npm run eval`) et viser une vingtaine de questions issues de l'usage réel, chacune avec la session attendue. Les échecs SHALL être documentés comme écarts lexicaux connus plutôt que corrigés par retouches de scoring ; un manque répété est le signal qui arbitre l'activation des embeddings, avant tout travail dessus.

#### Scenario: Écart lexical documenté

- **WHEN** une question d'usage échoue en top-1 de façon répétée
- **THEN** l'échec est consigné dans le harnais comme écart connu et alimente la décision d'activer le retriever embeddings.

### Requirement: Ancrage temporel à l'instant de l'ancre (read --at)

Décision du 20/09 (analyse du premier passage réel et son rescopage) : sur une question d'état, la vérité terrain est l'état **à l'instant où la question a été posée**, pas l'état final de la session (4 dérives temporelles mesurées : n05, n44, n46, n50). Le CLI SHALL offrir, sur la lecture d'une session, l'option `--at <ancre>` qui masque les messages **postérieurs** à l'ancre, afin qu'un agent ou un humain puisse lire la session dans l'état où elle était à cet instant.

L'ancre SHALL accepter au minimum un identifiant de message de la session (`msg_…`) ; un horodatage explicite SHOULD être accepté (date, date et heure, ou millisecondes epoch, interprétés dans le fuseau d'affichage documenté). L'ancre résolue SHALL être **affichée** en tête de sortie, avec l'identifiant du message retenu et sa date, afin qu'une ancre erronée soit visible et non silencieuse. Les messages dont l'horodatage est **égal** à celui de l'ancre SHALL être visibles (inclusion).

Le masquage SHALL être **explicite** : la sortie SHALL porter un marqueur indiquant le nombre de messages masqués, l'ancre appliquée, et le fait qu'une lecture sans `--at` montre la session entière. Aucun masquage silencieux ne SHALL être possible. Le masquage est un filtre d'affichage : `sdig raw <partId>` et l'archive restent intégralement accessibles.

L'ordre des opérations SHALL être fixé et documenté : le masquage temporel détermine d'abord la vue lisible, puis les options de fenêtrage (`--around <msgId>`, `--ctx N`, `--tail N`) s'appliquent **dans** cette vue. Une fenêtre qui ne contiendrait que des messages postérieurs à l'ancre SHALL produire un message explicite (le dire, avec l'ancre rappelée), jamais une sortie vide ambiguë. Une ancre illisible ou absente de la session SHALL produire une erreur explicite et un code de sortie non nul, sans sortie partielle trompeuse. Le format `--json` SHALL exposer l'ancre résolue et le nombre de messages masqués.

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

#### Scenario: Ancre exposée en JSON

- **WHEN** la lecture bornée est demandée en `--json`
- **THEN** la sortie porte l'ancre résolue (identifiant, horodatage) et le nombre de messages masqués, exploitables par un script ou un harnais d'évaluation.

#### Scenario: Aucune détection de mutation

- **WHEN** la session contient une modification d'état antérieure à l'ancre
- **THEN** l'outil ne la signale pas et ne l'interprète pas : `--at` borne la lecture dans le temps, il ne prétend pas qualifier les changements d'état.
