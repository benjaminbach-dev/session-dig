# Design — add-cli-chronological-sort

## D0 — Ce que ce change est et n'est pas

Ce change est **documentaire** : il fige le cadrage minimal retenu pour un tri chronologique CLI, sans implémenter quoi que ce soit. Il ne touche ni au scoring BM25, ni au schéma du corpus, ni à l'API MCP, ni au mode `--raw`. Il ne remplace pas `relevance` et ne prétend pas que la feature est livrée.

Le besoin : prouver une « première trace » globale (premier message, premier assistant d'un modèle) et offrir un ordre chronologique déterministe sur un corpus multi-source. Le tri BM25 répond bien à « le plus pertinent », mal à « le plus ancien ».

## D1 — Surface d'option et défaut

- `--sort relevance|oldest|newest`, **option omise = `relevance`**. En `relevance`, le chemin et le résultat actuels sont **inchangés** (aucune modification de `search()` : `ORDER BY score, id COLLATE BINARY LIMIT @limit`).
- **Option présente sans valeur** (`--sort` en fin d'arguments ou suivi d'une autre option, ex. `--sort --limit 1`) → erreur de valeur manquante, sans consommer l'option suivante (après ajout de `sort` aux options reconnues, le parser général actuel consommerait `--limit` comme valeur sans ce garde-fou : le chemin `--sort` devra détecter le token d'option). Valeur inconnue → erreur. `relevance` sans requête → erreur explicite (jamais de `'*'` inventé, jamais de déversement sans limite). `sdig` sans aucun argument conserve l'aide existante.
- `oldest`/`newest` : la requête est optionnelle ; c'est le seul mode où `q` peut manquer. La distinction est **physique** : requête positionnelle omise = mode exploration ; requête fournie vide, en espaces ou en stopwords seuls = normalisation existante (`no_terms` ou zéro hit), **jamais** de bascule silencieuse en mode exploration.
- `--sort` est refusé sur les sous-commandes (`ingest`, `read`, `raw`, `index`, `refresh`, `status`, `migrate`, `fingerprint`, `mcp`) même avec une valeur valide. Les sous-commandes CLI peuvent nommer `--sort` et sa valeur d'énumération ; `mcp` a un parser **dédié et fermé** : son refus est un message FIXE sans recopie de l'argument ni de sa valeur (confidentialité), sans changement du parser MCP ni de l'API. Aujourd'hui `--sort` n'appartient pas au `known` de `parseArgs` (`bin/sdig.js:117`) : il échoue déjà comme option inconnue ; l'implémentation future devra **conserver** ce refus sur les sous-commandes tout en l'acceptant pour la recherche.

## D2 — Mode avec mots-clés : sélection globale puis ordre

Avec `q` et `--sort oldest|newest`, la sélection porte sur **tous** les matches filtrés, puis l'ordre et `--limit` s'appliquent. On ne réutilise donc pas le `LIMIT` du chemin BM25.

Chemin d'implémentation prévu, sans réécrire le scoring :
1. Reprendre la clause de matching existante (`ftsQuery(q, 'OR')` : stopwords, tokenizer unicode, phrases pour jetons pointés) et les mêmes prédicats de filtres (`repo`, `session`, `source`, `after`, `before`, `model`, `role`, `agent`) que `search()` dans `src/retriever/bm25.js`.
2. Remplacer l'ordre `score, id` par `e.ts ASC/DESC, e.id COLLATE BINARY ASC/DESC`, avec `LIMIT @limit` après l'ordre.
3. Le score BM25 peut être projeté en diagnostic (`rank AS score`) mais n'entre jamais dans l'`ORDER BY` chronologique.

La sélection peut donc scanner tous les matches filtrés (SQL) : coût honnête, **aucune** garantie de < 100 ms. Le chargement JS reste borné aux `--limit` lignes rendues + contexte `--ctx`.

## D3 — Mode sans mots-clés : sous-ensemble canonique

Sans `q`, il n'y a pas de `MATCH` FTS (pas de requête `'*'`). Le sous-ensemble est lu directement dans la vue (`events`), avec `role IN ('user','assistant')` **intersecté** avec le `--role` fourni, et sans `raw` :

- Le sous-ensemble canonique est **toujours** l'intersection `role ∈ {user, assistant}` ∩ filtre `--role` : `--role title` ou une valeur inconnue → **zéro hit** sans mots-clés, jamais l'inclusion d'une ligne `title`.
- Lignes `title` exclues : ce sont des lignes synthétiques d'index, pas des messages.
- Événements à `text` vide ou à `cmd` seuls **inclus** (le mode chrono n'est pas un mode FTS).
- Filtres exacts réutilisés. `--source` porte sur la **provenance archivée**, pas sur la disponibilité actuelle : source inconnue → zéro hit (sémantique `COALESCE(json_extract(e.json,'$.source'),'opencode')`), mais une source archivée dont la base a disparu du disque reste cherchable, sans lecture de la source d'origine.
- Métadonnée de modèle absente jamais inventée : sans `--model`, tous les assistants sont candidats, y compris sans modèle ; `--model M` filtre par sous-chaîne comme en pertinence. Le JSON porte `model: null` explicite ; l'avertissement est **conditionnel** (émis seulement si un hit assistant rendu a un modèle absent, jamais par scan exhaustif, et pas en `--role user`) et va sur `stderr` en JSON pour garder `stdout` = tableau pur. C'est un signal général documenté de la limite, pas une garantie exhaustive.

## D4 — Ordre global déterministe

Clé **`(ts, id COLLATE BINARY)`**, `ts` en epoch millisecondes (`events.ts INTEGER`, index `events_ts`), jamais une chaîne de date ; `ts = 0` valide. Le départage par `id` canonique qualifié (`pi:<sessionId>:<id>`, `COLLATE BINARY`) rend l'ordre stable entre sources et entre exécutions. L'affichage des dates reste UTC (convention `--at`).

Distinction explicite : la date de **création de session** (`tsCreated`) n'est pas la date du **premier message** ; le tri porte sur les événements. La « première session » (liste globale de sessions) reste hors périmètre.

Qualification de `oldest --limit 1` : sans mots-clés (ou avec `--role user|assistant`), il rend le plus ancien **message** du sous-ensemble canonique de l'archive courante ; avec mots-clés, le plus ancien **record indexé** peut être une ligne `title` — un titre n'est pas une preuve de premier message, et son `ts` provient des métadonnées de session (`tsCreated`), jamais d'une date de texte de message.

## D5 — Affichage humain : ordre global, pas de regroupement trompeur

`groupBySession()` et `renderTerminal()` regroupent par session et ordonnent les groupes par l'ordre d'arrivée des hits (donc par score en mode relevance). En chrono, ce regroupement casserait l'entrelacement global. Le rendu chrono doit donc préserver l'ordre global : **rendu plat, une entrée par hit** (variante « flat par session » possible seulement si elle conserve l'ordre global), et l'en-tête doit afficher mode/sens (`oldest`/`newest`) pour qu'un score diagnostique éventuel ne soit pas confondu avec l'ordre. Le regroupement par session de la spec reste la règle du mode `relevance` (défaut).

## D6 — JSON, score et `--ctx`

- `--json` reste un **tableau** de hits (pas d'enveloppe `{hits:…}`), champs conservés : `ts` numérique, `id`, `sessionId`, `role`, `model` (`null` explicite si absent, jamais inventé), `text` intégral.
- `score` reste **numérique** en `relevance` (inchangé) et en chrono **avec** mots-clés (rang BM25 calculé par hit en diagnostic, jamais `undefined` ; les valeurs peuvent différer entre hits sans déterminer leur ordre). Seul le **nouveau mode chrono sans mots-clés** peut porter `score: null` : c'est un comportement de mode nouveau, **pas** un élargissement de type du mode `relevance`, qui reste strictement intact.
- `--ctx` conserve `neighborsBySessionDb` (`src/read.js`) : les voisins restent des voisins, ordonnés chronologiquement, distincts des hits, et la déduplication des fenêtres ne change ni l'ordre ni le rang principal. C'est une commodité d'affichage **humain** : en `--json`, la sortie rend les hits seuls (tableau) et **n'ajoute aucune clé `contexte`/`ctx`**.
- L'avertissement « modèle absent » (mode sans mots-clés) va sur `stderr` en JSON, conditionnel aux hits assistants rendus : `stdout` reste un tableau JSON pur.

## D7 — Garde-fous de périmètre

- Aucune sous-commande nouvelle (pas de `sessions`), aucun outil MCP nouveau, aucun changement de curseur/pagination MCP. Le refus MCP reste un message FIXE sans recopie d'argument (parser dédié fermé, confidentialité), sans modification d'API.
- `--raw` + chrono refusé explicitement : mélanger hints FTS et scan brut ne produit pas un ordre global honnête ; le mode `--raw` par défaut est inchangé.
- `--at` reste propre à `read` ; `--after`/`--before` gardent leur sémantique de bornes.
- Vue courante + snapshot de lecture seule réutilisés (`inReadTx`, `checkFresh`) : vue absente/périmée → refus existant, jamais de réparation/réindexation/relecture de source implicite. Aucun index de source créé.
- `--limit` = troncature, pas d'exhaustivité ni de curseur ; `--sort oldest --limit 1` = minimum du **sous-ensemble canonique filtré de l'archive courante**, pas le premier usage historique de l'outil.

## D8 — Position vis-à-vis des changes actifs

- `scale-corpus` (actif) modifie « Interface Retriever », « Performance » et « Recherche brute optionnelle ». Ce change **n'y touche pas** et préserve l'interface `index(corpus)`/`search(query)` : le tri chronologique est une **lecture de la vue** (nouvelle requête d'ordre), pas une modification du retriever ni de son contrat. Un helper de lecture bornée peut être ajouté sans refactor d'API.
- `add-pi-adapter` (actif) modifie « CLI sdig » (`--source`, provenance des titres). Le delta `MODIFIED` de ce change reprend **le texte complet** de cette version (superset), pour ne pas perdre `--source`/provenance lors de l'archivage. **Règle d'ordre d'archivage, sans ambiguïté : `add-pi-adapter` d'abord, PUIS ce change (pi avant chrono).** Si l'ordre inverse était retenu, ce delta devrait être rebasé avant archivage, sinon le texte d'`add-pi-adapter` (sans `--sort`) écraserait l'option.
- Le mode `relevance` et les scenarios standards existants (requête dorée, regroupement, JSON, option inconnue, source, lecture préfixée) sont **conservés tels quels** dans le delta `MODIFIED`.

## D9 — Plan de validation futur (specs non implémentées)

L'implémentation future devra fournir des tests **synthétiques décisifs** (fixtures, aucune donnée réelle ni réplique d'évaluation gelée) :

- chrono avec plus de N matches et un plus ancien hors top-N BM25 → il sort en tête de `oldest --limit N` ;
- `ts` égaux, deux sources → ordre BINARY stable ;
- filtres appliqués **avant** tri/limite ; dates UTC ; `ts = 0` ; **source inconnue → zéro hit** ; **source archivée dont la base a disparu du disque → toujours cherchable, sans lecture de la source** ;
- `--role title` (ou rôle inconnu) sans mots-clés → zéro hit (intersection canonique) ; `oldest --limit 1` sans mots-clés = plus ancien message, avec mots-clés un `title` peut sortir mais n'est pas une preuve de premier message ;
- requête fournie vide / en espaces / en stopwords seuls → normalisation existante, pas de bascule en exploration ; `--sort` présent sans valeur (`--sort --limit 1`) → erreur sans consommer `--limit` ;
- sans `q` : assistants avec et sans modèle, `model: null` explicite, avertissement conditionnel et sur `stderr` en JSON, pas d'alerte en `--role user`, titre exclu, texte vide inclus ; avec `q` : titre encore éligible, `score` numérique diagnostique, et `--role user/assistant` cible le message ;
- affichage humain entrelaçant deux sessions vs JSON en tableau (sans clé `ctx`) respectant l'ordre ; `--ctx` non candidat ; `--limit` non exhaustif ;
- refus : `--sort` sans valeur/inconnu/hors recherche (dont `mcp`, message FIXE sans recopie), `--raw` + chrono ; vue absente/périmée → refus inchangé ;
- non-régression : mode `relevance` par défaut (score numérique) et dorées inchangés.

Validation OpenSpec de ce change : `openspec validate add-cli-chronological-sort --strict --no-interactive` (télémétrie désactivée).
