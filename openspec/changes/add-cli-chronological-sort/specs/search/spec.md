# Delta search — add-cli-chronological-sort

## MODIFIED Requirements

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

## ADDED Requirements

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
