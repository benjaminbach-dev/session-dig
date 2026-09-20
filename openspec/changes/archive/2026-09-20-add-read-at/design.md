# Design — add-read-at

Décisions arrêtées avant implémentation (SDD). Les points marqués « à trancher » au 20/09 sont
explicitement résolus ici ; toute remise en cause passe par un commit qui touche ce fichier.

## D1 — Formes d'ancre acceptées

- **Prioritaire** : identifiant de message de la session (`msg_…`, ou `prt_…`/id de part si le corpus
  sait le relier à son message — à vérifier à l'implémentation ; à défaut, refus explicite).
- **Horodatage explicite** : `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS]`, ou millisecondes epoch
  (13 chiffres). Interprétation dans le fuseau d'**affichage** (le même que celui utilisé par sdig
  pour dater les messages), documentée dans l'aide du CLI.
- Le corpus stocke des epoch ms : la comparaison se fait sur ces valeurs, jamais sur des chaînes.

## D2 — Inclusion à l'instant exact

Un message dont l'horodatage est **égal** à celui de l'ancre est **visible**. Raison : l'ancre vient
d'un message (celui de la question) ; l'exclure rendrait invisible le message qui porte la question,
ce qui est précisément le cas d'usage n46.

## D3 — Ordre des opérations

1. résolution de l'ancre (échec explicite si introuvable) ;
2. **masquage** : la vue = messages d'horodatage ≤ ancre ;
3. **fenêtrage** : `--around`/`--ctx`/`--tail` s'appliquent dans cette vue ;
4. rendu : marqueur d'ancre en tête, marqueur de masquage en fin de vue, marqueurs de troncature
   par message.

Corollaire : `--around <msgId postérieur>` est une erreur explicite (la fenêtre n'existe pas dans la
vue), pas un vide silencieux.

## D4 — Rendu du masquage (jamais silencieux)

Deux marqueurs distincts, non interchangeables :

- **masquage temporel** (fin de vue) : `… 12 message(s) postérieur(s) à l'ancre masqué(s) — relire
  sans --at pour voir la session entière` ;
- **en-tête d'ancre** (début de sortie) : `ancre : msg_… (2026-07-17 11:24)` — l'ancre résolue est
  toujours rappelée, pour qu'une ancre erronée soit visible ;
- **troncature d'affichage** (par message) : inchangée depuis `add-remedy-truncation`.

## D5 — Le masquage n'est pas un contrôle d'accès

`--at` ne restreint rien : `sdig raw <partId>` reste intégral, `--json` reste non tronqué, et la
recherche n'est pas filtrée. C'est un filtre de **lecture**, pas une coupe dans l'archive. Motif :
l'outil sert à enquêter, y compris pour vérifier ce qui s'est passé *après* l'ancre.

## D6 — Pas de détection de mutation (hors périmètre)

L'outil ne signale ni ne qualifie les changements d'état (permissions, config, outils). Le rescopage
du 20/09 a écarté ce chantier : il demanderait une analyse sémantique des messages, un autre projet.
`--at` répond seulement à « jusqu'où lire ».

## D7 — `--at` n'existe que sur `read`

`sdig search` garde `--after`/`--before` : ils sélectionnent des messages par date sans prétendre
reconstituer une vue bornée d'une session. Étendre `--at` aux hits groupés serait un autre débat
(fenêtres de contexte), non demandé.

## D8 — Validation

- **Tests unitaires** (fixture synthétique) : masquage des messages postérieurs, visibilité sans
  `--at`, inclusion de l'instant exact, fenêtre entièrement postérieure, ancre inconnue, ancre d'une
  autre session, horodatage illisible, `--json` (ancre + compte), coexistence avec `--full`/
  `--chars` et avec le marqueur de troncature.
- **Vérification locale non committée** sur le corpus réel : session de n46 (retrait de `bash` à
  11:38) — lire avec une ancre à 11:24 laisse l'outil visible, la lecture complète le montre retiré.
- **Pas de rejeu du jeu naturel** (décision utilisateur du 20/09). La question brûlée n46 n'entre pas
  dans `eval/queries.json`, qui mesure la recherche : l'écart avec la note d'analyse du 19/09 est
  assumé et documenté dans `proposal.md`.

## D9 — Piège d'implémentation connu

`parseArgs` : toute option non déclarée consomme l'argument suivant (incident `--raw` du 15/09).
Ajouter `--at` à la table des options **et** un test d'erreur sur option inconnue (exigence CLI
modifiée).
