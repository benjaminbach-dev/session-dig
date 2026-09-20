# Design — update-read-at

Décisions arrêtées avant le code. Elles complètent (sans les contredire) celles du change archivé
`2026-09-20-add-read-at` : ce dernier prévoyait une interprétation « dans le fuseau d'affichage
documenté », ce qui n'était pas implémenté (décalage local/UTC) — la D1 ci-dessous tranche.

## D1 — Référentiel horaire : UTC, point

- `fmtTs()` affiche UTC (`toISOString`). Les ancres horodatées sont donc **résolues en UTC**.
- Conséquence assumée : `--at 2026-09-05T09:00` désigne 09:00 **UTC**, partout, y compris sous
  `TZ=Europe/Paris`. Pas de `--tz`, pas d'heure locale : le corpus stocke des epoch ms, l'affichage
  est UTC, la résolution l'est aussi — une seule règle, vérifiable.
- Une ancre **epoch ms** est déjà absolue : inchangée.

## D2 — Validité calendaire stricte

`Date` normalise les dates inexistantes (`2026-02-30` → 2 mars) et les heures hors bornes
(`25:00` → lendemain 01:00). Une ancre qui glisse silencieusement d'un jour ou d'une heure déplace la
vue temporelle sans rien dire : c'est précisément la classe de défaut que `read --at` doit exclure.

- Validation **avant** construction : année 4 chiffres, mois 1–12, jour 1–N (nombre réel de jours du
  mois, années bissextiles incluses), heure 0–23, minute 0–59, seconde 0–59.
- Un contrôle d'aller-retour (`Date.UTC` → composantes) sert de garde-fou de second ordre, mais les
  bornes sont vérifiées explicitement pour que le message d'erreur soit précis.
- Message : `ancre invalide : 2026-02-30 (jour hors bornes pour février 2026)` — l'ancre fautive est
  nommée, jamais un simple échec générique.
- La forme **date seule** reste « fin de journée UTC » (`23:59:59.999`) : la journée demandée reste
  entièrement visible. Ce n'est pas un report, c'est la convention documentée depuis D1 du change
  `add-read-at`.

## D3 — Ancre vide = ancre illisible

- `--at ""` (ou espaces, ou `${VAR}` vide) : **erreur**, code de sortie non nul. Une valeur vide est
  un défaut d'appel, pas une absence d'option : la confondre avec « pas de `--at` » rouvrirait
  silencieusement la session entière — le masquage disparaîtrait sans marqueur.
- Implémentation : `sessionSlice` n'ignore plus une ancre vide (seul `undefined`/`null` = option
  absente) ; `resolveAnchor` rejette la chaîne vide et les espaces avec le motif « ancre vide ».

## D4 — Ce qu'on ne fait pas

- Pas de fuseau configurable (`--tz`), pas de tolérance aux saisies approximatives (`2026-2-3`,
  `5 sept`, `hier`) : une ancre fausse doit échouer, pas être devinée.
- Pas de changement du référentiel d'affichage (UTC) : c'est la résolution qui s'y aligne.
- Pas de retouche de la spec archivée `add-read-at` (les changes archivés sont historiques) : la
  contrainte est portée par ce change-ci.

## D5 — Tests sous plusieurs fuseaux

Un changement de fuseau doit être testé là où il se produit : au démarrage du processus. Les tests
lancent donc le CLI en sous-processus (`execFileSync`) avec `TZ=UTC` puis `TZ=Europe/Paris` (et un
troisième fuseau négatif, `TZ=America/New_York`) et comparent l'ancre résolue et la vue — plutôt que
de manipuler `process.env.TZ` dans le processus de test (effet de bord global, dépendant de la
plateforme).
