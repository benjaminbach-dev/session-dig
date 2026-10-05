# Tâches — add-mcp-chrono

> **Historique** : la première phase de ce change était **documentaire** (cadrage
> seul, aucun code). **Mise à jour du 05/10/2026** : l'utilisateur a autorisé
> explicitement l'implémentation effective. La phase 1 (spec) reste livrée et
> inchangée ; la **phase 2 (implémentation) est réalisée et relue** (moteur opt-in
> `boundedText` sur `searchChrono`/`browseChrono`, schémas/validation/handler MCP,
> tests synthétiques, docs). **Revalidation ciblée PC/MCP sur corpus réel effectuée**
> après reload : [bilan](validation-pc-2026-10-05.md). Aucun contenu privé n'est
> ajouté au dépôt, aucun archivage ni nouveau score du banc complet. L'ordre
> d'archivage (**`add-mcp-server` d'abord, puis ce change**) reste inchangé.

## 1. Phase spec (ce change uniquement)

- [x] 1.1 Rédiger `proposal.md` : besoin prouvé par le banc hermétique du 05/10/2026 (8/10, échec Q2 structurel) et le contournement SQL observé, cadrage minimal (`sort` sur `sdig_search`), portée, non-goals, position vis-à-vis d'`add-mcp-server` (OUVERT, delta `MODIFIED`) et d'`add-cli-chronological-sort` (réutilisation de la sémantique CLI, sans dépendance d'archivage).
- [x] 1.2 Rédiger `design.md` : surface de l'option (`sort` à valeurs fermées, `query` optionnelle en chrono seulement, contrainte croisée), sémantique des deux modes (avec/sans mots-clés), ordre `(ts, id BINARY)`, interaction avec les contrats existants (top-k sans curseur, `total`, enveloppe 524 288, extraits référencés, référencement read, fidélité pi), garde-fous, décisions prises et options rejetées, position vis-à-vis des changes actifs et ordre d'archivage.
- [x] 1.3 Écrire le delta `specs/mcp/spec.md` : `## MODIFIED Requirements` pour « Catalogue d'outils et fermeture » (texte complet, superset du delta `add-mcp-server`, réglementation de `sort`, requête optionnelle en chrono) et `## ADDED Requirements` « Tri chronologique de la recherche MCP », « Exploration MCP sans mots-clés », « Honnêteté et bornes du tri chronologique MCP ».
- [x] 1.4 Rédiger ces tâches (phase spec cochée, phase implémentation ouverte) et valider `openspec validate add-mcp-chrono --strict --no-interactive`, puis la validation globale `openspec validate --specs --changes --strict --no-interactive` (doit inclure ce change), et `git diff --check` propre.
- [x] 1.5 Relecture du principal et préparation de la livraison documentaire après corrections. Commit/push documentaire confié au principal sur autorisation explicite ; cette livraison n'autorise aucun début d'implémentation implicite. **Relecture faite le 05/10 (principal)** : vérification des bornes réelles (limit 10/50, query 512, ctx 0–5), comparaison clause par clause du `MODIFIED` avec l'exigence d'origine (superset : 40 phrases normatives conservées ou renforcées, 7 scénarios d'origine présents + 4 nouveaux), correction de la sémantique de `total` (exact sur la SÉLECTION, pas sur les hits rendus ; réduction d'enveloppe signalée dans `truncated.dimensions`, `total` inchangé — aligné sur `src/mcp/search.js:196` `knownTotal = rawCount < limit ? rawCount : null`).

## 2. Phase implémentation (autorisée le 05/10/2026, réalisée localement)

> **Implémentation effective autorisée par l'utilisateur le 05/10/2026.** Toutes les
> cases ci-dessous sont cochées sur la base de modifications réelles et de tests
> synthétiques locaux ; la validation réelle ultérieure est distincte (phase 3).
> Aucun archivage. L'ordre
> d'archivage (**`add-mcp-server` d'abord**, puis ce change) reste requis.

- [x] 2.1 Épingler le cadrage avec le principal avant tout code : `sort` à valeurs fermées (`relevance` défaut), `query` optionnelle **uniquement** en `oldest`/`newest`, aucune pagination ni curseur, aucun outil nouveau.
- [x] 2.2 `src/mcp/schemas.js` : ajouter `sort` (énumération fermée, optionnel) au schéma d'entrée de `sdig_search` ; rendre `query` structurellement optionnelle ; élargir le contrat de `score` à `number | null` (le `null` n'étant admis qu'en exploration) ; mettre à jour la description de l'outil (chrono, exploration, score diagnostique, sans curseur).
- [x] 2.3 `src/mcp/validate.js` : appliquer la règle croisée — `query` obligatoire si `sort` absent ou `relevance`, `query` omise autorisée seulement si `sort ∈ {oldest, newest}` ; valeur de `sort` inconnue et requête fournie vide/stopwords → `invalid_params` ; aucune bascule silencieuse.
- [x] 2.4 `src/mcp/search.js` : aiguiller vers `searchChrono` (avec requête) ou `browseChrono` (sans requête) du moteur partagé ; `limit` appliqué après l'ordre ; conserver `total` exact si `count < limit` sinon `null`, `topK`, `truncated`, l'enveloppe 524 288 et les références read ; en `oldest`/`newest`, l'ordre de `hits` porte la chronologie globale et `groups` reste un index de session.
- [x] 2.5 Extraits en exploration : produire un extrait borné par `substr` SQL sur `text`/`cmd` (pas de `snippet()` FTS), avec longueur réelle permettant de signaler exactement la coupure ; `score: null` ; `model: null` explicite. Implémenté comme option opt-in `boundedText` de `searchChrono`/`browseChrono` (chemins CLI par défaut inchangés), avec projections partagées de `relevance`.
- [x] 2.6 Non-régression : mode `relevance` (défaut) strictement inchangé ; `cursor` toujours refusé par search ; fidélité pi conservée ; aucun changement de `sdig_read`, `sdig_status` ni du CLI.
- [x] 2.7 Tests synthétiques décisifs (`test/mcp-chrono.test.js`, 20 tests) : plus de N matches dont le plus ancien hors top-N BM25 ; `ts` égaux multi-source (BINARY) ; filtres avant tri/limite ; `ts = 0` ; `role: title`/inconnu sans `query` → zéro hit ; texte vide/commande seule inclus ; extrait `substr` borné avec coupure signalée ; `model: null` explicite ; `score: null` en exploration et numérique en chrono avec requête ; `sort: relevance` sans requête → `invalid_params` ; `sort` inconnu → `invalid_params` ; requête fournie vide/stopwords → `invalid_params` ; source inconnue → zéro hit et source archivée absente du disque → toujours cherchable ; top-k sans curseur ; `total` exact/null ; enveloppe sous pression préservée ; commandes longues Unicode ; exploration `newest` et bornes ; vue absente/périmée → `view_unavailable` ; non-régression `relevance` ; refus CÔTÉ PROTOCOLE (client MCP officiel).
- [x] 2.8 Mettre à jour `docs/mcp.md` (paramètre `sort`, exploration sans mots-clés, score `null` en exploration, limites : top-k borné, pas de curseur) et la description de l'outil `sdig_search`.
- [x] 2.9 Validation finale d'implémentation LOCALE : suite MCP ciblée + `search-engine`/`cli-chrono` (moteur touché) + `openspec validate --specs --changes --strict --no-interactive`, sans données réelles ni jeu gelé dans le dépôt ; `git diff --check` propre. **Aucune validation PC ni MCP sur corpus réel.**

## 3. Revue et validation documentaire

- [x] 3.1 Validation OpenSpec ciblée `openspec validate add-mcp-chrono --strict --no-interactive` et globale `--specs --changes --strict --no-interactive`, `git diff --check` propre.
- [x] 3.2 Relecture du principal sur les quatre artefacts, cohérence avec `add-mcp-server` (ordre d'archivage : **`add-mcp-server` d'abord, puis ce change**) et `add-cli-chronological-sort` (réutilisation sémantique, sans dépendance d'archivage). Réalisée le 05/10/2026 après corrections ; points ouverts tranchés par le principal : `score` nullable uniquement en exploration (adaptation documentée acceptée), un seul `MODIFIED` (les autres exigences sont couvertes par les `ADDED`), extraits d'exploration par `substr` SQL borné avec indicateurs de coupure.
- [x] 3.3 Revue du principal sur l'implémentation le 05/10/2026 : diff relu, omission physique durcie (`query: undefined` refusée), description complétée (score diagnostique, modèle absent, ordre global), tests renforcés (20 chrono : budget sous pression, commandes Unicode, vue périmée, exploration newest). Validation principale : **270/270** tests ciblés MCP + search-engine/search/cli-chrono, OpenSpec ciblé/global **8/8**, `git diff --check` propre.
- [x] 3.4 Validation ciblée PC / MCP sur corpus réel après lancement manuel et reload — [bilan du 05/10](validation-pc-2026-10-05.md) : cas modèle retrouvé sans query, ordres oldest/newest, bornes, score null/numérique, source pi/fidélité, référence read, relevance inchangé sur la requête exercée, refus invalid_params. Ni banc hermétique complet ni intégrité bitwise ni stress réel sous budget revalidés.
- [ ] 3.5 Archivage (**`add-mcp-server` d'abord**) et décision de clôture — **non réalisés** ; aucun J-MCP plein annoncé par cette revalidation ciblée.
