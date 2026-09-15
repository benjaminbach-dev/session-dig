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

Le retriever `bm25` SHALL utiliser une base SQLite distincte du corpus via `better-sqlite3`, avec une table FTS5 en tokenizer unicode par défaut. Par défaut, l'index SHALL indexer le texte des messages `user` et `assistant` ET les commandes du champ `toolCall.cmd`, mais PAS les sorties d'outils (décision du 15/09 : les sorties volumineuses sont du bruit BM25 ; la ligne de commande est du signal pur). Les filtres structurés (`repo`, `session`, `ts`, `model`, `role`, `agent`) SHALL être des colonnes filtrables de l'index, pas des termes de requête.

#### Scenario: Bruit évité

- **WHEN** une requête cible un sujet technique
- **THEN** les hits proviennent des textes de messages et des commandes exécutées, jamais des sorties d'outils volumineuses.

#### Scenario: Filtre et recherche combinés

- **WHEN** une requête porte des mots-clés et un filtre `--repo ccp-proxy --after 2026-06-01`
- **THEN** seuls les événements du repo et de la période donnée sont candidats, et le classement BM25 s'applique à ce sous-ensemble.

### Requirement: CLI sdig

L'exécutable SHALL s'appeler `sdig` (le nom `dig` étant déjà pris par l'outil DNS). Usage : `sdig "requête" [--repo R] [--session S] [--after DATE] [--before DATE] [--model M] [--role R] [--agent A] [--limit N]`. La sortie SHALL afficher pour chaque hit : score, date, repo, id de session, rôle et un extrait avec termes surlignés. Les hits SHALL être regroupés par session à l'affichage (décision du 15/09 : le regroupement est une décision d'affichage, gratuite et réversible, le grain d'index restant le message) ; le tri interne reste le score. Une option `--json` SHALL exposer les résultats bruts pour script et tests.

#### Scenario: Requête dorée

- **WHEN** `sdig "bug proxy"` est exécuté sur le corpus fixture
- **THEN** la session contenant le fix attendu apparaît en premier, avec l'extrait surligné.

#### Scenario: Regroupement par session

- **WHEN** plusieurs hits appartiennent à la même session
- **THEN** ils sont affichés sous un en-tête de session commun, ordonnés chronologiquement dans le groupe.

#### Scenario: Sortie JSON

- **WHEN** `--json` est passé
- **THEN** la sortie est un JSON valide contenant les hits complets, sans décor de TUI.

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

#### Scenario: Hypothèse abandonnée

- **WHEN** un hit est une hypothèse corrigée plus loin dans la session
- **THEN** `--ctx` ou `sdig read --around` montre les messages suivants qui infirment ou confirment, sans quitter la recherche.

#### Scenario: Preuve en sortie brute

- **WHEN** un toolCall affiche un `rawRef`
- **THEN** `sdig raw <partId>` restitue la sortie complète enregistrée dans `raw/`.

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
