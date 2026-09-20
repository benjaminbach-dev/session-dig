# Change add-read-at

## Pourquoi

Le premier passage réel du jeu naturel (18-19/09, glm-5.3-flash) a produit **4 dérives temporelles**
(n05, n44, n46, n50) : sur une question d'état, l'agent répond l'état **final** de la session au lieu
de l'état **à l'instant où la question a été posée**. Cas vérifié dans le corpus : en n46, au moment
de la question (11:24) l'agent `explore` avait encore l'outil `bash` ; l'utilisateur le retire à
11:38 ; la réponse restitue l'état final. Ce n'est pas une invention — c'est un défaut d'ancrage.

Aujourd'hui, rien dans l'outil n'aide à répondre juste : `sdig read <session>` déroule la session
entière, tous états confondus, et c'est à l'agent de trier mentalement ce qui précède et ce qui suit
l'instant de la question. La remédiation retenue par l'analyse du 19/09 est **R2, volontairement
rescopée** :

- **dans le périmètre** : un filtre temporel simple — `--at <msgId|horodatage>` sur `read` masquant
  les messages **postérieurs** à l'ancre ;
- **hors périmètre** : la détection automatique des mutations d'état (reconnaître qu'un message
  modifie une configuration, une permission, un ensemble d'outils). C'est un chantier d'analyse
  sémantique, explicitement abandonné dans le rescopage du 20/09 ; l'outil ne prétend pas savoir
  *ce qui* a changé, seulement *quand* on s'arrête de lire.

Le principe est le même que celui du remède de troncation (`add-remedy-truncation`) : l'outil
n'arbitre pas à la place de l'agent, il rend la lecture bornée **possible et visible**. Un masquage
silencieux serait exactement le défaut qu'on vient de corriger ailleurs.

## Quoi change

- **ADDED** `Ancrage temporel à l'instant de l'ancre (read --at)` (spec `search`) : option
  `--at <msgId|horodatage>`, ancre résolue et **affichée**, messages postérieurs masqués avec un
  **marqueur explicite** (compte masqué + ancre + comment tout revoir), ordre des opérations fixé
  (masquage d'abord, puis fenêtre `--around`/`--ctx`/`--tail`), erreurs explicites (ancre
  introuvable, horodatage illisible, fenêtre entièrement postérieure), `--json` portant l'ancre et le
  compte masqué. Le masquage est un filtre d'**affichage** : il ne restreint aucun accès
  (`sdig raw` reste la preuve intégrale).
- **MODIFIED** `Lecture du contexte et accès à la preuve` : la lecture d'une session peut être bornée
  dans le temps ; le masquage temporel et la troncature d'affichage sont **deux signaux distincts**,
  jamais confondus dans le rendu.
- **MODIFIED** `CLI sdig` : l'usage de `read` documente `--at`.

Aucun changement de schéma de corpus, d'index, ni de scoring de recherche.

## Impact

- **Specs** : `search` (1 ajoutée, 2 modifiées). Le jeu naturel reste gelé : ce change ne le rejoue
  pas et ne le modifie pas.
- **Code** : `src/read.js` (résolution de l'ancre, troncature de la vue, marqueur), `src/format.js`
  (marqueur de masquage, distinct de celui de troncature), `bin/sdig.js` (`parseArgs` — piège connu :
  toute option non déclarée avale la suivante).
- **Validation** : tests unitaires sur la fixture synthétique (message de mutation à l'instant T,
  messages postérieurs masqués avec `--at`, visibles sans), cas limites (inclusion des messages à
  l'instant exact de l'ancre, fenêtre entièrement postérieure, ancre inconnue, `--json`), et une
  **vérification locale non committée** sur le corpus réel (session de n46 : l'ancre à 11:24 laisse
  `bash` visible alors que la lecture complète montre son retrait à 11:38) — le corpus et les
  sessions réelles ne sont jamais publiés.
- **Note d'écart assumée par rapport à l'analyse du 19/09** : celle-ci proposait de porter la question
  brûlée n46 « en régression dans `eval/queries.json` ». Or `eval/queries.json` mesure la
  **recherche** (top1/top3/top5, `knownMiss` sur la pertinence BM25) : un cas `read --at` n'y a pas de
  sens et y polluerait le contrat de scoring. La régression va donc dans les **tests unitaires de
  lecture** sur la fixture, et la vérification sur corpus réel reste locale (confidentialité). Le
  contrat de `eval/queries.json` est inchangé.
- **Non-goals** : pas de `--at` sur `search` (les filtres `--after`/`--before` y bornent la recherche
  par date sans masquer d'affichage) ; pas de reconstruction d'état ; pas de détection de mutation ;
  pas de re-passage du jeu naturel (l'efficacité du remède se mesurerait sur un jeu neuf, décision
  utilisateur du 20/09).
