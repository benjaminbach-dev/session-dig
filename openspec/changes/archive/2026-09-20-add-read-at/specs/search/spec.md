# Delta search — add-read-at

## MODIFIED Requirements

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

## ADDED Requirements

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
