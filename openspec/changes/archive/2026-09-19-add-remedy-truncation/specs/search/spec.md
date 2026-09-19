# Delta search — add-remedy-truncation

## MODIFIED Requirements

### Requirement: Lecture du contexte et accès à la preuve

Décision du 16/09 (retour d'agent) : retrouver un extrait n'est pas retrouver la solution — le message trouvé peut contenir une hypothèse abandonnée. Le CLI SHALL permettre, après une recherche : de lire les messages voisins d'un hit (`--ctx N` sur la recherche ; `sdig read <session> --around <msgId> [--ctx N] [--tail N]` pour dérouler une session), et de consulter la sortie d'outil brute associée à un appel (`sdig raw <partId>`, référencé par `rawRef` dans les résultats). Les voisins SHALL être rendus en ordre chronologique, les hits marqués, et les fenêtres de voisins de hits proches SHALL être fusionnées pour éviter les doublons d'affichage.

Décision du 19/09 (analyse du premier passage réel) : une coupure d'affichage silencieuse fait croire — à un agent comme à un humain — que l'archive ne contient pas la suite du message. Quand le rendu d'un message est tronqué, le CLI SHALL afficher un **marqueur de troncation** auto-suffisant : une mention explicite de limite d'affichage, les compteurs exacts (caractères affichés / caractères totaux du message) et le chemin vers le texte intégral (`--full`, `--chars N`, `sdig search --json`). L'option `--full` SHALL lever la limite d'affichage par message, l'option `--chars N` SHALL la fixer explicitement ; le format `--json` SHALL rester non tronqué. Un message rendu sans coupure SHALL produire aucun marqueur. Aucun message tronqué ne SHALL être rendu sans marqueur — dans `read` (messages, `--around`, `--ctx`, `--tail`) comme dans les hits groupés d'une recherche.

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
