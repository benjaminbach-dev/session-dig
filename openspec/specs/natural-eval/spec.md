# Évaluation naturelle (questions réelles tenues à l'écart)

## Purpose

Mesurer si un agent, placé dans une session neuve, sait **retrouver et restituer** ce qui s'est réellement dit dans l'historique de sessions de cet utilisateur — pas ce qu'un modèle sait du monde. Le jeu de test est constitué de questions réellement posées par l'utilisateur, tirées au hasard dans le corpus, avec leur vérité terrain issue de la réponse réellement donnée. Il sert à comparer des modèles et des configurations d'outillage sur un axe unique et honnête : « cet agent saurait-il retrouver ce qui s'est passé ici ? ».

Non-goals : ce n'est pas un benchmark public, ni un palmarès de modèles, ni un jeu d'entraînement. Les questions auto-dérivées du projet (cf. `specs/search`) servent au réglage ; ce jeu-ci sert à la mesure, et ne doit jamais servir au réglage.

## Requirements

### Requirement: Jeu de questions naturelles tenu à l'écart

Le jeu SHALL être extrait du corpus par tirage aléatoire déterministe (graine fixe, aucune source d'aléa non reproductible), puis **curé par un humain** : le tirage propose, l'humain retient. Chaque question SHALL avoir : un identifiant stable, le texte de la question **verbatim** (seuls les artefacts injectés par le client — blocs `<system-reminder>`, lignes de délégation de sous-agent — sont retirés), au moins deux faits attendus (`expect`), la provenance exacte (identifiant de session, identifiant du message utilisateur, date, modèle, dépôt) et trois étiquettes : `type` (`fait`, `etat`, `decision`, `conseil`, `veille`), `specificity` (`high`, `medium`, `low`) et `selfContained` (la question se comprend-elle hors contexte ?).

Le jeu SHALL contenir au moins 40 questions, dont la majorité de spécificité `high` ou `medium` — une question dont la réponse vit dans la culture générale ne discrimine rien et SHALL être étiquetée `low`, jamais supprimée pour autant (elle sert de témoin). Les paires SHALL être vérifiées automatiquement contre le corpus : la session et le message utilisateur existent, le message est bien de rôle `user`, la question nettoyée n'est pas vide, `expect` n'est pas vide. Une extraction ou une curation qui échoue à cette vérification SHALL échouer bruyamment, jamais produire un jeu partiel silencieux.

#### Scenario: Tirage reproductible

- **WHEN** l'extraction est relancée avec la même graine et le même corpus
- **THEN** elle produit le même échantillon, et la curation retrouve ses identifiants d'origine.

#### Scenario: Vérité terrain vérifiée

- **WHEN** une paire est construite
- **THEN** la session et le message utilisateur cités sont retrouvés dans le corpus, sinon la construction échoue avec la liste des problèmes.

### Requirement: Confidentialité du jeu de test

Le jeu contient des extraits réels de l'historique privé (chemins, projets, décisions). Il SHALL rester local : jamais committé, jamais publié, jamais inclus dans un export partagé — les dépôts du projet sont publics. Les runners d'évaluation et les rapports d'exécution SHALL être dans des emplacements ignorés par Git, et la documentation committée SHALL décrire la méthode sans recopier de question ni de vérité terrain.

#### Scenario: Publication accidentelle empêchée

- **WHEN** un commit est préparé dans le dépôt du projet
- **THEN** ni les questions, ni les vérités terrain, ni les rapports d'exécution ne sont inclus, seuls les scripts et la spécification de méthode le sont.

### Requirement: Passation à la question seule

L'agent testé SHALL ne recevoir que l'identifiant et le texte des questions. La vérité terrain, la provenance (session source), les notes et les étiquettes de difficulté SHALL être exclues de l'export de passation : un agent qui voit la réponse attendue ou la session à citer ne mesure plus rien. L'export SHALL être produit par une commande dédiée, dans un ordre mélangé de façon déterministe (pour éviter que les questions d'une même session se suivent dans la passation).

#### Scenario: Fuite de la vérité terrain interdite

- **WHEN** un export de passation est généré
- **THEN** il ne contient que les identifiants et les questions, et sa lecture par l'agent testé ne lui révèle ni les faits attendus ni la session source.

### Requirement: Conditions d'exécution du test

Chaque exécution SHALL se dérouler dans une **session neuve** (aucun historique de la conversation d'évaluation, aucun contexte préalable du corpus), sur un agent dont le modèle et l'outillage sont documentés. Deux variantes SHALL être distinguées, et toujours annoncées dans le rapport :

- **variante A — avec archive** (mesure principale) : l'agent accède au corpus en lecture seule via `sdig` (ou son exposition MCP quand elle existera) ; il SHALL citer la ou les sessions utilisées.
- **variante B — sans archive** (témoin de contamination) : l'agent n'a aucun accès au corpus ; elle mesure ce qu'un modèle peut répondre sans l'archive, donc la part non discriminante du jeu.

L'agent testé SHALL ne pas lire les fichiers du jeu de test (`questions.jsonl`, `questions.md`, `curated.json`, `runs/`) : une exécution où cette lecture a eu lieu SHALL être déclarée invalide plutôt que notée. Les questions SHALL être posées telles quelles ; les reformuler pour aider l'agent rend le résultat inexploitable.

#### Scenario: Session neuve exigée

- **WHEN** une exécution démarre
- **THEN** elle part d'une session vide et le rapport mentionne le modèle, les outils disponibles, la variante et le fait que la session était neuve.

#### Scenario: Exécution polluée

- **WHEN** l'agent testé a lu les fichiers de vérité terrain ou a reçu un indice non prévu
- **THEN** l'exécution est marquée invalide et exclue de l'agrégat, en le disant explicitement.

### Requirement: Notation en deux scores distincts

Chaque réponse SHALL être notée sur deux axes séparés, parce qu'ils échouent séparément :

1. **Rappel (retrieval)** : l'agent a-t-il cité la session source (identifiant de session, ou titre sans ambiguïté) ? Un agent qui répond juste sans citer, en variante A, n'a pas fait le travail demandé et SHALL être noté manquant sur cet axe.
2. **Fidélité (fidelity)** : les faits attendus sont-ils présents et corrects, sans affirmation interdite (`mustNot`) et sans invention ? La notation SHALL valoriser l'abstention honnête (« je ne trouve pas dans l'archive ») au-dessus d'une réponse inventée : une abstention est un échec de rappel, une invention est un échec de fidélité **et** un signal de fiabilité négatif.

Les résultats SHALL être rapportés par étiquette (`high` seul, puis `high`+`medium`, puis ensemble), et non seulement en score global : un score global mélangeant des questions de culture générale et des questions d'archive ne dit rien. Un écart documenté (question légitimement ambiguë, réponse devenue fausse depuis) SHALL être consigné comme tel et exclu de l'agrégat, jamais compté comme échec silencieux.

#### Scenario: Bonne réponse mal sourcée

- **WHEN** en variante A l'agent donne les bons faits sans citer la session source
- **THEN** le score de fidélité peut être plein, le score de rappel est nul, et les deux sont rapportés séparément.

#### Scenario: Invention

- **WHEN** l'agent affirme un fait contredit par la vérité terrain ou par `mustNot`
- **THEN** la question est comptée en échec de fidélité et alimente le taux d'hallucination du rapport.

### Requirement: Rapport d'exécution

Chaque exécution SHALL produire un rapport daté et lisible contenant : modèle, variante, conditions (session neuve, outils disponibles), version du jeu de test, notes par question (rappel, fidélité, citation fournie, verbatim de la réponse fautive), agrégats par étiquette, taux d'hallucination et taux d'abstention. Les rapports SHALL être conservés localement à côté du jeu de test, pour permettre la comparaison entre exécutions successives.

#### Scenario: Comparaison entre deux modèles

- **WHEN** deux modèles passent le même jeu dans les mêmes conditions
- **THEN** les deux rapports portent la même version du jeu et la même variante, et leurs agrégats sont comparables ligne à ligne.

### Requirement: Gel et cycle de vie du jeu de test

Un jeu de test utilisé pour publier un résultat SHALL être gelé : ses questions ne SHALL plus être modifiées, seules des questions nouvelles peuvent être ajoutées dans une version ultérieure (les résultats antérieurs restent attachés à leur version). Le jeu SHALL ne jamais servir au réglage du retriever : dès qu'une question oriente une décision d'implémentation, elle cesse d'être une mesure. Les questions dont la réponse dépend d'un état vivant (contenu d'un dossier, outil installé) SHALL être étiquetées `volatile` et jugées contre l'archive, jamais contre l'état actuel du système.

#### Scenario: Question utilisée pour le réglage

- **WHEN** une question du jeu naturel motive une modification du retriever ou du corpus
- **THEN** elle est retirée de la mesure et versée au jeu de réglage (`eval/queries.json`), car une question réglée n'est plus une question testée.

#### Scenario: Question volatile

- **WHEN** une question porte sur un état du système susceptible d'avoir changé
- **THEN** elle est étiquetée `volatile`, la notation se réfère à l'état décrit dans l'archive, et l'écart éventuel avec l'état actuel est documenté comme tel.
