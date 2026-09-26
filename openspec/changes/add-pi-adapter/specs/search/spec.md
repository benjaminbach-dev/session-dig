# Delta search — add-pi-adapter

## Purpose

Exposer la provenance des hits dans la recherche : le corpus devenant multi-source, le CLI gagne un filtre `--source` et le rendu identifie la source de chaque session. Aucun changement du scoring, du grain ni des vues — la fusion est déjà faite à l'ingestion.

## MODIFIED Requirements

### Requirement: CLI sdig

L'exécutable SHALL s'appeler `sdig` (le nom `dig` étant déjà pris par l'outil DNS). Usage : `sdig "requête" [--repo R] [--session S] [--source S] [--after DATE] [--before DATE] [--model M] [--role R] [--agent A] [--limit N]`. La sortie SHALL afficher pour chaque hit : score, date, repo, id de session, rôle et un extrait avec termes surlignés. Les hits SHALL être regroupés par session à l'affichage (décision du 15/09 : le regroupement est une décision d'affichage, gratuite et réversible, le grain d'index restant le message) ; le tri interne reste le score. Une option `--json` SHALL exposer les résultats bruts pour script et tests.

Le filtre `--source` SHALL filtrer sur le champ `source` des événements et sessions (correspondance exacte, ex. `opencode`, `pi`) ; les lignes de titre synthétiques portent la source de leur session et sont filtrées comme les messages ; une source inconnue produit zéro résultat, pas une erreur. Combiné à `--raw`, le filtre `--source` borne aussi le scan des preuves : seules les sorties brutes de la source sélectionnée sont parcourues (les `partId` pi étant préfixés `pi:`, la sélection est déterministe, sans lecture des preuves des autres sources).

Les sous-commandes de lecture (`sdig read <session>`) SHALL documenter leurs options dans l'aide du CLI : `--around <msgId>`, `--ctx N`, `--tail N`, `--full`, `--chars N` et `--at <msgId|horodatage>` (exigence « Ancrage temporel à l'instant de l'ancre »). L'identifiant complet de session, préfixe de source compris (ex. `pi:<uuid>`), est l'adresse canonique pour `read` ; `--session` accepte l'identifiant complet ou un préfixe de celui-ci (comportement préfixe inchangé par ailleurs). Toute option non reconnue SHALL produire une erreur explicite plutôt que d'être ignorée silencieusement.

#### Scenario: Requête dorée

- **WHEN** `sdig "bug proxy"` est exécuté sur le corpus fixture
- **THEN** la session contenant le fix attendu apparaît en premier, avec l'extrait surligné.

#### Scenario: Regroupement par session

- **WHEN** plusieurs hits appartiennent à la même session
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
- **THEN** le CLI échoue avec un message nommant l'option, au lieu de consommer silencieusement l'argument suivant.
