# Change update-read-at

## Pourquoi

`add-read-at` a livré l'ancrage temporel ; trois défauts de saisie ont été reproduits le 20/09, tous de la même famille : **la vue devient fausse ou non bornée sans que rien ne le dise** — exactement ce que le remède existe pour empêcher.

| Saisie | Comportement observé | Attendu |
|---|---|---|
| `--at 2026-02-30` | report silencieux au **2 mars** : l'ancre ne désigne plus la date demandée | erreur explicite |
| `--at 2026-09-05T25:00` | débordement au **lendemain 01:00** | erreur explicite |
| `TZ=Europe/Paris sdig read … --at 2026-09-05T09:00` | ancre interprétée en heure **locale**, affichée en **UTC** → `07:00` affiché, décalage invisible d'une à plusieurs heures | interprétation en UTC, comme l'affichage |
| `--at ""` (variable shell vide) | la session **entière** s'affiche, comme si l'option n'existait pas | erreur explicite |

Les deux premiers cas sont des reports de calendrier par `Date` (JavaScript normalise les dates inexistantes) ; le troisième est une incohérence entre la résolution et `fmtTs` (qui affiche en UTC via `toISOString`) ; le quatrième est cette classe de bug que le projet connaît déjà — une option dont la valeur disparaît (cf. le piège `parseArgs` du 15/09) et un filtre qui ne s'applique plus.

## Quoi change

- **MODIFIED** `Ancrage temporel à l'instant de l'ancre (read --at)` (spec `search`) :
  - horodatages interprétés en **UTC**, référentiel de l'affichage — même ancre, même vue, quel que soit le fuseau du processus ;
  - horodatage **calendairement valide** exigé (date inexistante, heure/minute/seconde hors bornes → erreur explicite, jamais de report silencieux) ;
  - ancre **vide** refusée comme illisible (une variable shell vide ne doit pas rouvrir la session entière) ;
  - quatre scénarios ajoutés : date inexistante, débordement d'heure, ancre vide, indépendance du fuseau.

Aucun changement de sémantique du masquage : l'ordre des opérations, les marqueurs, l'inclusion de l'instant exact et le périmètre (pas de détection de mutation) restent tels quels.

## Impact

- **Specs** : `search` (1 requirement modifié, 4 scénarios ajoutés).
- **Code** : `src/read.js` (`resolveAnchor` : validation stricte + UTC + ancre vide ; `sessionSlice` : une ancre fournie n'est plus ignorée quand elle est vide), `bin/sdig.js` (aide : UTC et refus explicites), `README.md` (même précision).
- **Tests** : dates impossibles (`2026-02-30`, mois 13, jour 0), débordements (`25:00`, minute 75), ancre vide en bibliothèque **et** en CLI (exit non nul), et **indépendance du fuseau** vérifiée par sous-processus (`TZ=UTC` vs `TZ=Europe/Paris`) : même ancre résolue, même vue.
- **Non-goals** : pas de fuseau configurable (`--tz`), pas de changement du référentiel d'affichage (il reste UTC — c'est la résolution qui s'y aligne), pas de tolérance aux saisies approximatives (une ancre fausse doit échouer, pas être devinée), pas de `--at` sur la recherche.
