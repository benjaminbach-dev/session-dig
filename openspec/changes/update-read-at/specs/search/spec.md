# Delta search — update-read-at

## MODIFIED Requirements

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
