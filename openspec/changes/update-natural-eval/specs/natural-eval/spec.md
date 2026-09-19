# Delta natural-eval — update-natural-eval

## MODIFIED Requirements

### Requirement: Conditions d'exécution du test

Chaque exécution SHALL se dérouler dans une **session neuve** (aucun historique de la conversation d'évaluation, aucun contexte préalable du corpus), sur un agent dont le modèle et l'outillage sont documentés. Deux variantes SHALL être distinguées, et toujours annoncées dans le rapport :

- **variante A — avec archive** (mesure principale) : l'agent accède au corpus **uniquement via `sdig`** (ou son exposition MCP quand elle existera) ; il SHALL citer la ou les sessions utilisées. La lecture directe de fichiers est interdite : tout fichier du répertoire du corpus (`events.jsonl`, `sessions.jsonl`, `raw/`, index), `opencode.db`, `index.db`, ou toute base sqlite. Le prompt d'examen SHALL porter explicitement cette règle, et le template de prompt utilisé SHALL être épinglé (hash consigné dans le rapport).
- **variante B — sans archive** (témoin de contamination) : l'agent n'a aucun accès au corpus ; elle mesure ce qu'un modèle peut répondre sans l'archive, donc la part non discriminante du jeu. Le de-blindage résiduel du prompt système de l'hôte (instructions globales, descriptions d'outils visibles du sujet) SHALL être documenté comme une condition de la variante, jamais compté comme fuite de vérité terrain.

Une exécution interrompue (connexion perdue alors que le serveur d'agent a terminé le traitement) MAY être **récupérée** via le transcript de la session d'examen. Une réponse récupérée est légitime si et seulement si : (a) elle porte le flag `recovered`, (b) l'extrait de transcript qui la fonde est archivé à côté du rapport, (c) le nombre de réponses récupérées figure dans le rapport. Sans ces preuves, la réponse est traitée comme manquante.

L'agent testé SHALL ne pas lire les fichiers du jeu de test (`questions.jsonl`, `questions.md`, `curated.json`, `runs/`) : une exécution où cette lecture a eu lieu SHALL être déclarée invalide plutôt que notée. Les questions SHALL être posées telles quelles ; les reformuler pour aider l'agent rend le résultat inexploitable.

#### Scenario: Session neuve exigée

- **WHEN** une exécution démarre
- **THEN** elle part d'une session vide et le rapport mentionne le modèle, les outils disponibles, la variante et le fait que la session était neuve.

#### Scenario: Exécution polluée

- **WHEN** l'agent testé a lu les fichiers de vérité terrain ou a reçu un indice non prévu
- **THEN** l'exécution est marquée invalide et exclue de l'agrégat, en le disant explicitement.

#### Scenario: Déviation d'accès détectable

- **WHEN** la variante A contient une lecture directe de fichiers du corpus ou des bases sources
- **THEN** elle est listée par l'audit des accès (requirement dédié) et qualifiée dans le rapport ; l'affirmation « zéro déviation » ne peut plus reposer sur la seule attention de l'examinateur.

#### Scenario: Récupération après coupure

- **WHEN** la connexion d'examen est perdue alors que le serveur a fini le traitement
- **THEN** la réponse est moissonnée via le transcript, porte le flag `recovered`, est prouvée par l'extrait archivé et comptée dans le rapport ; sans preuve, elle est manquante.

### Requirement: Notation en deux scores distincts

Chaque réponse SHALL être notée sur deux axes séparés, parce qu'ils échouent séparément :

1. **Rappel (retrieval)** : l'agent a-t-il cité la session source — identifiant complet, ou titre sans ambiguïté, ou identifiant tronqué si l'identifiant complet figure ailleurs dans la même réponse ? Un agent qui répond juste sans citer, en variante A, n'a pas fait le travail demandé et SHALL être noté manquant sur cet axe.
2. **Fidélité (fidelity)** : les faits attendus sont-ils présents et corrects, sans affirmation interdite (`mustNot`) et sans invention ? La notation SHALL valoriser l'abstention honnête (« je ne trouve pas dans l'archive ») au-dessus d'une réponse inventée : une abstention est un échec de rappel, une invention est un échec de fidélité **et** un signal de fiabilité négatif.

La fidélité SHALL être notée **fait attendu par fait attendu** : chaque entrée d'`expect` reçoit ✔ (restitué), ~ (partiel) ou ✖ (absent). Le **tableau par question** (rappel + une colonne par fait) est la donnée première du rapport ; les listes agrégées n'en sont qu'une vue. Les buckets SHALL être dérivés sans ambiguïté : **pleine** = tous les faits ✔ ; **partielle** = au moins un fait non-✔ avec au moins un fait restitué (✔ ou ~) ; **échec** = aucune restitution (ni ✔ ni ~). Aucun bucket intermédiaire (quasi-pleine, faible…) n'est admis : la restitution partielle se lit dans le tableau, pas dans un label — l'expérience du 19/09 a montré que les labels intermédiaires dérivent.

Une affirmation d'absence ou de complétude contredite par le corpus (le texte intégral du message source y existe, extraction à l'appui) est une **fausse méta-affirmation** : le fait concerné est compté ✖, l'affirmation est tracée comme signal distinct et agrégée en taux propre — elle est plus grave qu'un détail perdu, car elle décrit faussement la source ; elle n'est pas une invention (le fait est dans l'archive).

La vérité terrain d'une question d'état est **ancrée à l'instant de la question** : restituer un état postérieur (mutation ultérieure dans la même session, ou état d'une session postérieure) est une **dérive temporelle**, comptée en échec de fidélité et documentée comme telle — jamais comptée comme invention.

Les résultats SHALL être rapportés par étiquette (`high` seul, puis `high`+`medium`, puis ensemble), et non seulement en score global : un score global mélangeant des questions de culture générale et des questions d'archive ne dit rien. Un écart documenté (question légitimement ambiguë, réponse devenue fausse depuis) SHALL être consigné comme tel et exclu de l'agrégat, jamais compté comme échec silencieux.

#### Scenario: Bonne réponse mal sourcée

- **WHEN** en variante A l'agent donne les bons faits sans citer la session source
- **THEN** le score de fidélité peut être plein, le score de rappel est nul, et les deux sont rapportés séparément.

#### Scenario: Invention

- **WHEN** l'agent affirme un fait contredit par la vérité terrain ou par `mustNot`
- **THEN** la question est comptée en échec de fidélité et alimente le taux d'hallucination du rapport.

#### Scenario: Granularité reproductible

- **WHEN** deux correcteurs notent les mêmes réponses avec la même clé
- **THEN** leurs tableaux par question coïncident fait par fait aux arbitrages près, et tout désaccord est tranché par extraction du texte source du corpus.

#### Scenario: Fausse absence

- **WHEN** une réponse affirme que l'archive ne contient pas la suite d'un message alors que le texte intégral y figure
- **THEN** le fait est compté ✖, la réponse alimente le taux de fausses méta-affirmations, et l'arbitrage cite l'identifiant du message source.

#### Scenario: Dérive temporelle

- **WHEN** une réponse d'état restitue un état postérieur à l'instant de la question
- **THEN** elle est comptée en échec de fidélité avec la mention « dérive temporelle », sans être comptée comme invention.

### Requirement: Rapport d'exécution

Chaque exécution SHALL produire un rapport daté et lisible contenant : modèle et fournisseur, variante, conditions (session neuve, outils disponibles), **conditions épinglées** — md5 du corpus au début et à la fin, version de sdig, version du serveur d'agent, hash du template de prompt, graine d'ordre —, version du jeu de test, **tableau de notation par question** (rappel, fidélité fait par fait, citation fournie, verbatim des réponses fautives), agrégats par étiquette et par bucket, taux d'invention, taux d'abstention, taux de fausses méta-affirmations, compte et preuves des réponses `recovered`, et résultat de l'audit des accès. Les rapports SHALL être conservés localement à côté du jeu de test, pour permettre la comparaison entre exécutions successives.

#### Scenario: Comparaison entre deux modèles

- **WHEN** deux modèles passent le même jeu dans les mêmes conditions
- **THEN** les deux rapports portent la même version du jeu et la même variante, et leurs agrégats sont comparables ligne à ligne.

#### Scenario: Conditions comparables

- **WHEN** deux rapports datant de périodes différentes sont comparés
- **THEN** chacun porte ses md5, versions et hash de prompt épinglés, et toute divergence de conditions est énoncée avant toute comparaison de chiffres — deux runs sans conditions épinglées ne comparent rien.

## ADDED Requirements

### Requirement: Audit déterministe des accès

Le dépôt SHALL embarquer un script d'audit des accès (`scripts/audit-toolcalls.mjs`) qui scanne les appels d'outils enregistrés d'une exécution (un JSON par réponse, champ `toolCalls`) et liste, par question, toute commande touchant directement l'archive : fichiers du répertoire du corpus (`events.jsonl`, `sessions.jsonl`, `raw/`), `opencode.db`, `index.db`, invocations sqlite, `sdig ingest`/`sdig refresh`. La liste des motifs SHALL être épinglée dans le script — toute évolution passe par un commit. L'audit est un **filet de détection a posteriori, pas une garantie d'exclusivité d'accès** : quand le harnais d'examen permet de restreindre réellement les accès (outils désactivés hors sdig, wrapper de commandes n'exposant que sdig, environnement confiné), la restriction réelle SHALL être préférée ; l'audit reste obligatoire dans tous les cas. Le résultat de l'audit SHALL être annexé au rapport ; un rapport sans audit est déclaré « non audité » en toutes lettres. L'audit liste les faits (question, outil, extrait de commande) ; la qualification de gravité reste une décision humaine écrite dans le rapport.

#### Scenario: Déviation détectée

- **WHEN** un run contient une lecture directe de `events.jsonl` ou une ouverture sqlite
- **THEN** le script la liste avec le numéro de question, l'outil et un extrait de commande, sans faux positif sur les invocations légitimes de sdig (`read`, `raw`, `search`, `status`, `index`).

#### Scenario: Run sain

- **WHEN** toutes les commandes d'un run passent par sdig
- **THEN** l'audit ne liste rien et le rapport peut porter « zéro déviation » avec la preuve attachée.

#### Scenario: Restriction réelle préférée au filet

- **WHEN** le harnais d'examen permet de filtrer les commandes exécutables ou de n'exposer que sdig
- **THEN** la variante A s'exécute avec cette restriction réelle, et l'audit ne sert qu'à confirmer — un filet ne remplace pas une porte.

### Requirement: Inter-notation indépendante

Le premier rapport noté d'un jeu gelé SHALL être relu par un second correcteur indépendant de l'examinateur, au minimum sur : toutes les réponses non pleines, les écarts de procédure (questions jamais notées, réponses `recovered`, déviations d'accès), et un échantillon de réponses pleines. Chaque désaccord SHALL être arbitré contre le corpus par extraction du texte intégral du message source, citation à l'appui, et consigné ; la grille arbitrée fait foi pour l'agrégat final. Une re-notation ne fait jamais rejouer le jeu : elle relit des réponses existantes, sans coût modèle.

#### Scenario: Désaccord arbitré

- **WHEN** les deux correcteurs divergent sur un fait
- **THEN** l'extraction du message source tranche, la citation est consignée, et la grille finale porte la version arbitrée.

#### Scenario: Écart de procédure comblé

- **WHEN** une question n'a jamais été notée par l'examinateur
- **THEN** le relecteur la note sur la réponse existante et le rapport final le documente comme écart de procédure comblé.
