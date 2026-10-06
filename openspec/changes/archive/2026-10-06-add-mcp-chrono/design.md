# Design — add-mcp-chrono

> **Mise à jour du 05/10/2026 — phase implémentation.** Ce design a d'abord fixé un
> cadrage **documentaire**. Sur autorisation explicite de l'utilisateur, la feature a
> ensuite été **implémentée localement** conformément à ces décisions : option opt-in
> `boundedText` ajoutée à `searchChrono`/`browseChrono` (extraits SQL bornés côté
> exploration, projections partagées de `relevance`, chemins CLI par défaut
> inchangés), schémas/validation/handler MCP, tests synthétiques et `docs/mcp.md`.
> Les mentions « documentaire », « sans implémenter » et « aucun test de code » ci-
> dessous décrivent la **phase spec historique**. La revalidation ciblée PC/MCP
> sur corpus réel est désormais [consignée](validation-pc-2026-10-05.md), sans
> rejouer le banc complet ni archiver ; `tasks.md` fait foi pour l'état des tâches.

## D0 — Ce que ce change est et n'est pas

Ce change est **documentaire** : il fige le cadrage minimal d'un tri chronologique dans les outils MCP, sans implémenter quoi que ce soit. Il ne touche ni au scoring BM25, ni au schéma du corpus, ni au CLI, ni au mode `relevance`, ni au curseur de `sdig_read`. Il ne prétend pas que la feature est livrée, ni que le MCP atteindra l'exhaustivité.

Le besoin est prouvé par le **banc hermétique du 05/10/2026** (`eval/hermetic/results-2026-10-05.md`) : un agent sous cloche avec les seuls `sdig_search`/`sdig_read`/`sdig_status` réussit 8/10 questions, mais échoue **Q2** (« première utilisation du modèle GLM 5.3 ») parce que `sdig_search` **exige une requête plein texte** et **n'a pas de tri par date** : l'agent ne peut ni énumérer « tous les messages de X » (il devine des mots et rate ceux qui ne les contiennent pas), ni ordonner par date (il sonde par bornes et espère que le top-k remonte le plus ancien). Le contournement SQL observé en usage réel en découle.

Le tri chronologique CLI (`add-cli-chronological-sort`, implémenté localement) est le **modèle de sémantique** : même ordre `(ts, id BINARY)`, mêmes filtres, même distinction physique entre requête omise (exploration) et requête fournie vide (normalisation existante). La logique de sélection existe déjà côté moteur (`src/retriever/bm25.js` : `searchChrono`, `browseChrono`), ce qui rend la faisabilité établie sans réécriture du scoring.

## D1 — Surface de l'option et défaut

`sort` est un paramètre **optionnel** de `sdig_search`, à valeurs **fermées** : `relevance` (défaut) | `oldest` | `newest`. Toute autre valeur est refusée (`invalid_params`), jamais ramenée silencieusement à `relevance`.

- **`sort` absent ou `relevance` explicite** : chemin et résultat actuels **strictement inchangés** (`search(..., { boundedText: true })`, top-k BM25, `ORDER BY score, id COLLATE BINARY`).
- **`query`** devient *structurellement optionnelle* dans le schéma d'entrée, mais la contrainte réelle est **croisée** : `query` est obligatoire si `sort` est absent ou `relevance` ; `query` peut être omise seulement si `sort ∈ {oldest, newest}`. Comme `validateReadInput` pour les règles croisées du curseur, c'est `validate.js` qui applique cette règle, pas Zod seul.
- **`query` fournie et valide** (≤ 512 caractères, terme exploitable) en `oldest`/`newest` : mode **chronologique avec mots-clés** (`searchChrono`).
- **`query` physiquement omise** en `oldest`/`newest` : mode **exploration sans mots-clés** (`browseChrono`).
- **`query` fournie mais vide / en espaces / sans terme exploitable** (stopwords, ponctuation) : refus `invalid_params` (règles `min(1)` + `EXPLOITABLE` + `SearchQueryError`/`no_terms` existantes), dans **tous** les modes. **Jamais** de bascule silencieuse en exploration : la distinction porte sur la **présence physique** du champ, pas sur son contenu (miroir du CLI).

`limit` (défaut 10, plafond 50), `ctx` (0–5) et les autres filtres gardent leur contrat. `sort` ne s'applique qu'à `sdig_search` ; `sdig_read` et `sdig_status` n'acceptent toujours pas `cursor`/`sort` hors de leur schéma strict.

## D2 — Sémantique des deux modes

### Avec mots-clés (`searchChrono`)

La clause de matching (`ftsQuery(q, 'OR')` : stopwords fr+en, tokenizer unicode, jetons pointés en phrases) et les prédicats de filtres (`filterSql` : `repo`, `session`, `source`, `after`, `before`, `model`, `role`, `agent`) sont **identiques** au mode `relevance`. Seul l'ordre change : sélection de **tous** les matches filtrés, puis `ORDER BY e.ts ASC|DESC, e.id COLLATE BINARY ASC|DESC LIMIT @limit`. Le score BM25 (`rank`) reste projeté en `score` **diagnostique**, sans intervenir dans l'ordre. `ts = 0` est valide. Les lignes `title` restent éligibles comme en `relevance` (compatibilité), mais leur `ts` provient des métadonnées de session et n'est pas une preuve de premier message.

### Sans mots-clés (`browseChrono`)

Aucun `MATCH` FTS, donc aucune requête `'*'` inventée. Le sous-ensemble **canonique** est l'intersection `role ∈ {user, assistant}` ∩ filtre `role` éventuel : `role: title` ou valeur inconnue → **zéro hit**, jamais l'inclusion d'une ligne de titre (artefact d'index). Les événements à texte vide ou à commandes seules sont **inclus** (ce n'est pas un mode FTS). Les filtres exacts sont réutilisés. `source` porte sur la **provenance archivée** (`COALESCE(json_extract(e.json,'$.source'),'opencode')`) : une source inconnue rend zéro hit, mais une source archivée dont la base d'origine a disparu du disque reste cherchable, sans lecture de la source.

`model` absent n'est jamais inventé : `model: null` explicite, `model: M` filtre par sous-chaîne comme en `relevance`.

## D3 — Ordre global déterministe

Clé `(ts, id COLLATE BINARY)`, `ts` en epoch millisecondes entier, jamais une chaîne de date. Le départage par id canonique qualifié (`pi:<sessionId>:<id local>`, `opencode` : id local) en ordre binaire rend l'ordre **stable entre sources et entre exécutions**. La distinction « premier message » / « première session » est conservée : le tri porte sur les événements, jamais sur `tsCreated`. `oldest --limit 1`-like (`sort: oldest`, `limit: 1`) rend le plus ancien **record indexé du sous-ensemble filtré de la vue courante**, pas le premier usage historique.

## D4 — Interaction avec les contrats MCP existants

Tout ce qui existe est **préservé** ; est explicitement adapté ce qui doit l'être.

- **Top-k sans curseur** : le chrono **reste un top-k borné** (`limit` ≤ 50). `search` refuse toujours tout `cursor` et n'émet **jamais** de `nextCursor` ; une troncature par `limit` n'est pas une exhaustivité. L'affinage passe par des bornes temporelles (`after`/`before`) ou des filtres plus restrictifs, jamais par une pagination.
- **`total` et `count`** : la formule existante s'applique telle quelle, calculée sur la **sélection** (nombre de matches filtrés), pas sur les hits effectivement rendus — `total` exact quand la sélection compte moins de `limit` matches, `null` sinon, jamais estimé ; une réduction d'enveloppe est signalée dans `truncated.dimensions` (dimension `hits`) et ne modifie pas `total`. En chrono, la sélection SQL étant bornée par `limit`, un compte inférieur à `limit` prouve qu'il n'y avait pas plus de matches. `topK` reste `limit`.
- **Enveloppe** : l'assemblage hit-first puis voisins sous 524 288 octets est inchangé ; la réduction éventuelle sous `limit` reste signalée dans `truncated`, sans curseur.
- **Extraits référencés** : chaque hit porte toujours un extrait borné et une référence `sdig_read` (un titre référence la seule session). **Point d'implémentation** : en exploration il n'y a pas de `snippet()` FTS ; l'extrait doit être produit par un `substr` borné côté SQL sur `text`/`cmd`, avec une longueur réelle permettant de signaler exactement la coupure (équivalent des indicateurs `snipFull`/`snipCmdFull` actuels). L'extrait reste signalé comme extrait, jamais présenté comme complet.
- **Référencement read** : inchangé. Les voisins `searchNeighbors` sont indexés par `(ts, id)` et excluent `role = 'title'` ; ils fonctionnent donc tels quels en chrono et en exploration, restent des voisins non candidats et ne modifient ni l'ordre ni le rang.
- **Fidélité pi** : le signal structuré reste émis pour toute donnée pi rendue (hits/voisins/titres) ; search sans donnée pi n'émet rien.
- **Ordre des `hits`** : en `oldest`/`newest`, le tableau `hits` porte l'ordre chronologique global ; `groups` reste un **index de session** (groupé par première apparition), jamais une garantie d'ordre. La « platitude » d'affichage est une décision CLI (rendu humain) ; le MCP rend des données, où `hits` fait foi.

## D5 — Garde-fous et score

- `sort` : énumération fermée, valeur inconnue → `invalid_params`. `relevance` sans `query` → `invalid_params` (jamais de `'*'` inventé, jamais de déversement sans borne).
- `score` : **numérique** en `relevance` (inchangé) et en chrono **avec** requête (BM25 calculé par hit, jamais `undefined`, sans déterminer l'ordre) ; **`null`** en exploration sans requête (BM25 non calculé). C'est une **adaptation explicitement documentée** du type du champ (passe de `number` à `number | null`), pas un score inventé : elle n'affecte que le mode nouveau.
- Aucune mutation implicite : la vue courante et le snapshot de lecture seule existants sont réutilisés (`openReadSnapshot`, `checkFresh`). Vue absente ou périmée → `view_unavailable` existant ; aucune réparation, réindexation ou lecture de source déclenchée.
- Aucun outil nouveau, aucun `sdig_raw`, aucun changement du curseur `read`, aucun egress, journaux inchangés.

## D6 — Décisions prises et options rejetées

**Prises :**

1. Réutiliser la **sémantique CLI** (ordre, filtres, distinction requête omise/vide) plutôt qu'inventer une convention MCP.
2. Faire de `query` une contrainte **croisée** avec `sort` (schéma structurellement optionnel, règle appliquée par `validate.js`), à l'image des règles croisées du curseur `read`.
3. Envelopper `score: null` dans le mode exploration, avec contrat de type élargi **documenté**.
4. Conserver `total`/`count`/`topK`/`truncated`/enveloppe/extraits/fidélité **sans élargissement** (seul `score` change de domaine).

**Rejetées / non retenues :**

- **Import du message d'avertissement CLI « modèle absent »** (stderr conditionnel) : le MCP n'a pas de canal `stderr` de réponse ; `model: null` explicite porte déjà l'information, et les descriptions documentent le champ. Ajouter un canal d'avertissement est un changement de contrat séparé — **hors périmètre**.
- **`score: null` global** (y compris en `relevance`) : réprouvé, casserait le contrat de pertinence. Le `null` est **strictement** cantonné à l'exploration sans requête.
- **Tri chronologique appliqué à un top-k BM25 déjà réduit** : rejeté, il ne garantit pas le plus ancien (cause exacte de l'échec Q2).
- **Curseur/pagination de recherche** pour compenser la borne `limit` : rejeté (extension déjà listée hors jalon dans `add-mcp-server`).
- **Nouveau filtre** ou **nouvel outil** dédié au chrono : rejeté, `sort` sur `sdig_search` suffit et évite d'élargir le catalogue fermé.
- **Scan des preuves brutes** (`raw/`) pour dater : rejeté, `sdig_raw` reste absent ; le tri porte sur la vue.

## D7 — Position vis-à-vis des changes actifs et ordre d'archivage

- **`add-mcp-server` (OUVERT)** : ce change le **MODIFIE**. Le delta `MODIFIED` reprend le **texte complet** de « Catalogue d'outils et fermeture » (superset du texte d'`add-mcp-server`), pour ne rien perdre à l'archivage. **Règle d'ordre : `add-mcp-server` d'abord, PUIS `add-mcp-chrono`.** Sinon, le `MODIFIED` n'a pas d'exigence de base et l'archivage échoue (openSpec refuse `MODIFIED` sur une spec cible inexistante).
- **`add-cli-chronological-sort` (OUVERT)** : **référence sémantique** uniquement ; aucune dépendance d'archivage. La fonctionnalité moteur (`searchChrono`/`browseChrono`) est locale et ce change ne modifie pas la spec `search`.
- **`scale-corpus` (OUVERT)** : non touché. La lecture chronologique utilise la vue et le snapshot existants ; l'interface Retriever et ses exigences de performance ne sont pas modifiées. Le coût assumé (scan SQL de l'ensemble des matches filtrés) est **documenté**, sans garantie de durée — cohérent avec le contrat « bornes de volume, pas de durée » de `add-mcp-server`.

## D8 — Plan de validation futur (specs non implémentées)

L'implémentation future devra fournir des tests **synthétiques décisifs** (fixtures, aucune donnée réelle ni réplique de jeu gelé) :

- `sort: oldest/newest` avec plus de N matches dont le plus ancien hors top-N BM25 → il sort en tête de `limit: N` (sélection globale, pas top-k réutilisé) ;
- `ts` égaux, deux sources → ordre BINARY stable et reproductible ; `ts = 0` valide ;
- filtres appliqués **avant** tri et limite ; bornes `after`/`before` ; `source` inconnue → zéro hit ; source archivée absente du disque → toujours cherchable sans lecture de source ;
- exploration sans `query` : `role: title`/inconnu → zéro hit ; texte vide/commande seule inclus ; `model: null` explicite ; `score: null` ;
- chrono avec `query` : titre toujours éligible, `score` numérique diagnostique, ordre `(ts, id)` ;
- requête fournie vide / en espaces / stopwords seuls → `invalid_params`, pas d'exploration ; `sort` absent avec requête → `relevance` inchangé ; `sort: relevance` sans requête → `invalid_params` ; valeur de `sort` inconnue → `invalid_params` ;
- préservation : top-k sans curseur (`cursor` refusé), `total` exact/null, enveloppe 524 288, extraits référencés, fidélité pi, référencement read ; vue absente/périmée → `view_unavailable` ;
- non-régression : mode `relevance` par défaut (score numérique, ordre BM25) et tests MCP existants inchangés.

Validation LOCALE d'implémentation (faite le 05/10/2026) : `test/mcp-chrono.test.js` (20 tests synthétiques), suites `search-engine` et `cli-chrono` (moteur touché) et `openspec validate --specs --changes --strict --no-interactive`. Cette validation synthétique précède la [revalidation ciblée PC/MCP sur corpus réel](validation-pc-2026-10-05.md). Aucun jeu de données réel ni réplique gelée dans le dépôt.
