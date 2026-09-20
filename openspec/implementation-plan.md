# Plan d'implémentation session-dig

Établi le 15/09 en brainstorming. Les specs font foi (`specs/corpus`, `specs/search`) ; ce plan ordonne le travail et consigne les décisions d'architecture prises avant le code.

## Décisions consignées (15/09)

1. **Grain = le message**, pas le tour (turn). L'agrégation vers le haut est triviale, la découpe vers le bas impossible. Les regroupements (contexte d'échange) se font à l'affichage : cluster de hits par session.
2. **`model`, `cost`, `tokens`, `exitCode` capturés dès le schéma v1** — gratuit à l'ingestion, coûteux à rétro-indexer. Ouvre la porte aux stats de comparaison de modèles (v2).
3. **Sorties d'outils hors du JSONL** (`raw/`), référencées par id de part. Seule la ligne de commande (`toolCall.cmd`) est indexée par défaut : signal pur, zéro bruit BM25.
4. **Corpus normalisé entre source et index** : c'est la couture qui rend les futures sources (Claude Code, zsh, git reflog) et les futurs retrievers (embeddings) additives.
5. **CLI nommé `sdig`** — `dig` est déjà le binaire DNS ; même logique que `quota` (commande native, symlink `/usr/local/bin`).
6. **Embeddings non exclus** : le projet n'est pas contraint au contexte proot/Termux ; le retriever BM25 est le maillon v0, pas une limite. L'interface `Retriever` est le contrat commun.

## Phase v0 — le prototype — **IMPLÉMENTÉE le 16/09**

1. ✅ **Adaptateur opencode** (`src/adapter/opencode.js`) : ouverture `readonly` (+ repli copie tmp si WAL verrouillé), sessions/messages/parts → corpus. Watermark `time_updated`, incrémental + `--rebuild` (raw/ purgé et régénéré). Vérifié sur données réelles : 4 983 events / 233 sessions / 5 204 raw (~4,1 Mo) en 7,3 s ; idempotence octet par octet ; rebuild identique.
2. ✅ **Retriever bm25** (`src/retriever/bm25.js`) : index.db FTS5 (external content), colonnes filtrables, cmd indexée, outputs exclus. Rebuild complet à chaque `sdig index` (index jetable, trio db/wal/shm supprimé).
3. ✅ **CLI `sdig`** (`bin/sdig.js`) : `ingest` / `index` / `refresh` / `status` / recherche par défaut ; filtres --repo --session --after --before --model --role --agent --limit ; `--json`, `--plain`.
4. ✅ **Tests** (`node --test`) : 23 pass — fixture synthétique (base opencode-like minimaliste), requêtes dorées (proxy 461 → ses_fix1, cmd git revert via toolCalls), contrat retriever (retrouvabilité, idempotence, index jetable, ordre par rang), idempotence ingestion, incrémental (message modifié/nouveau), rebuild, base absente.
5. ✅ **Bench** (`npm run bench`) : 5 000 events synthétiques → indexation 190 ms, pire requête 10,9 ms (cible spec < 100 ms : marge ×9).

### Décisions d'implémentation consignées (16/09)
- **`toolCalls` = liste** (jusqu'à 34 appels/message en réel — spec patchée) ; `rawRef` = id de part, sortie dans `raw/<id>.txt`.
- **Parts ignorées en v0** : `reasoning`, `patch`, `snapshot`, `step-start`, `compaction`, `agent`, `file` (spec patchée ; récupérables plus tard via rebuild).
- **tokens/cost** : depuis `message.data` si présents, sinon somme des `step-finish` (les deux formes existent en réel).
- **exitCode** : chaîne best-effort `state.metadata.exitCode` → `state.exitCode` → `state.error.exitCode` (et variantes snake_case) ; omis sinon.
- **cmd non-bash** : champ le plus parlant de `state.input` (`command`, puis query/pattern/url/file/…, sinon JSON compact tronqué 200).
- **Requête FTS** : AND strict, repli OR si 0 hit (« bug proxy 461 » ne doit pas répondre vide quand les termes sont dispersés).
- **repo null** pour directory = home ou `/` (sessions globales).
- **watermark** = max `time_updated` lu ; une vraie mise à jour opencode bump `time_updated` → toujours relu (test fixture le vérifie avec un timestamp réel, pas un delta).

### Limites connues v0
- Ingestion recharge toutes les parts à chaque passe (20 k lignes ≈ 1 s — optimisation par-ples que si le corpus dépasse ~100 k messages).
- `--plain` n'ôte les ANSI que des snippets (en-têtes de session restent gras) — cosmétique.
- `sdig` non encore installé en commande native (symlink /usr/local/bin/sdig à décider).

## Phase v0.1 — lecture du contexte et preuve — **IMPLÉMENTÉE le 16/09** (retour d'agent)

1. ✅ `sdig read <session> --around <msgId> [--ctx N] [--tail N]` : dérouler une session autour d'un hit (fenêtres fusionnées, hit marqué ►, index positionnels).
2. ✅ `--ctx N` sur la recherche : voisins ±N rendus en place, chronologiques, hits marqués, fenêtres fusionnées (pas de doublon).
3. ✅ `sdig raw <partId>` : preuve — sortie d'outil complète depuis `raw/` ; `rawRef` affiché sur chaque toolCall.
4. ✅ `--raw` : recherche sous-chaîne optionnelle dans `raw/` (stderr inclus), resituée (session, date, outil, cmd) — les sorties restent hors index BM25.
5. ✅ Tests +6 (mergeWindows, slice/around/tail, ctx rendu, fusion sans doublon, rawScan erreur stderr) → **29/29**.

## Phase v0.2 — évaluation sur recherches réelles — **FAITE le 17/09 (26 questions auto)**

- ✅ `eval/queries.json` (26 questions : 5 seeds + 21 auto dérivées des sessions réelles, provenance notée) + `npm run eval` : top1/top3/top5, `knownMiss` (écart documenté), exit 1 si miss non documenté.
- ✅ **Résultat : top1 26/26 · top3 26/26 · top5 26/26** — après trois améliorations *motivées par l'éval* (pas des retouches ad hoc) :
  1. **Indexation des titres de session** (ligne synthétique `role: title` par session) — corrigeait « mécanisme compaction » (titre portait tout le vocabulaire) et « rédiger specs console kirby ».
  2. **Stopwords fr+en retirés des requêtes** — « comment marche la compaction » perdait contre des sessions saturées d'« opencode ».
  3. **OR pondéré BM25 au lieu d'AND-strict-avec-repli** — l'AND faisait gagner un dump de config « fourre-tout » (contenait tous les termes) contre la vraie réponse. Plus jetons pointés (`chutes.ai`) → phrases FTS5.
- 4 vérités terrain clarifiées (sessions légitimes trouvées ajoutées à `expect`, notes explicatives) : sous-agent recherche Chutes.ai, session police Lilex/Termux, session test ctx_search, sous-agent specs plugin ai agent.
- ⚠ **Réserve honnête** : ces questions sont auto-dérivées (vocabulaire souvent proche des titres) — biais favorable. Les questions **utilisateur** (« je cherchais cette décision-là ») restent la vraie mesure : les ajouter dans `eval/queries.json` remplacera progressivement les auto, et leurs échecs éventuels documenteront le cas embeddings (v2) bien mieux que les miens.

## Phase v0.3 — jamais de coupure silencieuse — **IMPLÉMENTÉE le 20/09** (change `add-remedy-truncation`)

- ✅ Marqueur de troncation auto-suffisant (compteurs exacts + chemin `--full` / `--chars N` / `search --json`) sur `read` (messages, `--around`, `--ctx`, `--tail`) et sur les hits groupés ; `--full` lève la limite, `--chars N` la fixe, `--json` rend le texte intégral. Deux correctifs de mesure trouvés à l'usage (décorations comptées à tort, guillemets source).
- ✅ Régression : `npm run eval` porte désormais 28 questions (26 dorées + 2 « brûlées » reformulées depuis le jeu naturel, jamais verbatim).

## Phase v0.4 — évaluation traçable et ancrage temporel — **IMPLÉMENTÉE le 20/09**

Deux changes issus de l'analyse du premier passage réel (19/09) et de son rescopage du 20/09 :

1. ✅ **`update-natural-eval`** — audit déterministe des accès (`scripts/audit-toolcalls.mjs` : motifs épinglés + empreinte, reconnaissance de la **commande invoquée**, section « à examiner », statut « audit incomplet ») ; grille de notation committable (unité = fait attendu, buckets stricts, fausses méta-affirmations, dérives temporelles) ; inter-notation indépendante. Effet mesuré : le « 0 déviation » du rapport du 19/09 était faux — 9 commandes en déviation sur `run-A`, 9 sur le pilote, 0 (audit incomplet) sur le témoin.
2. ✅ **`add-read-at`** — `sdig read <session> --at <ancre>` (id de message, `AAAA-MM-JJ[THH:MM]`, epoch ms) masque les messages postérieurs : ancre résolue **affichée**, marqueur explicite du compte masqué, inclusion de l'instant exact, **masquage d'abord puis fenêtrage** `--around`/`--ctx`/`--tail`, erreurs explicites (ancre inconnue, ancre d'une autre session, fenêtre entièrement postérieure), `--json` avec `anchor` + `maskedCount`. Tests 75/75.
   - **Décision** : le masquage est un **filtre de lecture**, pas un contrôle d'accès (`sdig raw` reste intégral, `--json` non tronqué) ; `--at` n'existe que sur `read` (la recherche garde `--after`/`--before`) ; **hors périmètre** : la détection automatique des mutations d'état (le remède rend la lecture bornée *possible*, il ne dit pas *ce qui* a changé).
   - **Limite d'usage assumée** : le choix de l'ancre reste une décision du lecteur. Ancrer sur le message de la question masque la réponse qui documente l'état — vérifié sur la session source de n46 (cf. `eval/natural/runs/2026-09-20_read-at-verification-locale.md`, local) : le remède supprime la confusion avec l'état **final**, il ne dispense pas de viser la bonne borne.
   - **Validation** : tests de fixture (`test/read.test.js`), `npm run eval` inchangé (28/28 — la recherche n'est pas touchée), vérification locale sur corpus réel non committée.

## Phase v0.6 — échelle du corpus et de la vue — **SPECS ÉCRITES le 20/09 (change `scale-corpus`, documentaire)**

Contrainte posée par l'utilisateur : le projet doit tourner ailleurs — corpus 20-100× plus lourd au minimum, base source PC de 4 Go. Vérification code : la recherche tient (SQL pur FTS5) ; `readJsonl` plein-fichier, l'ingestion à réécriture intégrale et `raw/` plat cassent à l'échelle.

- ✅ Specs poussées (`scale-corpus`) : layout v2 éclaté en shards par session (enregistrements inchangés, `layoutVersion` dans state.json, refus explicite des autres versions) ; ingestion **O(delta)** (seuls les shards touchés réécrits, verrou flock, écritures atomiques, convergence après interruption) ; **vue dérivable SQLite en chemin de lecture unique** (JSON intégral + métadonnées, fenêtres bornées, fraîcheur vérifiée — refus explicite si vue absente/périmée, `read` devient dépendant de la vue) ; **mémoire bornée partout** (streaming, aucune commande ne charge le corpus entier) ; migration v1→v2 sans source ; empreinte déterministe du corpus (remplace le md5 de fichier unique dans les conditions d'éval) ; cibles re-visées au banc synthétique 100× (recherche p95 < 100 ms @ 500k événements).
- Décision d'ordre : **v0.6 code avant v1 MCP** — sinon la façade MCP hérite des parcours complets et ses workers gonflent en RAM. La spec MCP ouverte reste valable telle quelle (size-agnostique) ; son implémentation ajoutera « workers sans chargement complet » (satisfait de facto par la vue).
- ⏳ Implémentation : change séparé, sur accord explicite.

## Phase v1 — petit serveur MCP lecture seule (remonté, ex-v3 — retour d'agent)

- Exposer dig/read/raw en MCP (pattern agora-scout) : les agents opencode et Agora creusent l'historique eux-mêmes.
- Lecture seule, bornes de taille de résultat, politique de confidentialité à spécifier avant implémentation (SDD : nouvelle spec `mcp`).

## Phase v2 — embeddings + RRF — **conditionnés par l'évaluation**

- Retriever embeddings (chunk au message, modèle local ou API via proxy ccp) derrière la même interface + fusion RRF — seulement si l'éval v0.2 montre un manque lexical répété et documenté.

## Phase v3 — sstats — axe distinct (retour d'agent : l'exitCode n'est PAS une mesure de qualité)

- Comparaison de modèles sur usage réel : coût par problème résolu, tokens/cache par tâche, **exitCode traité comme signal d'exécution brut** (un échec peut être un diagnostic pertinent — jamais interprété seul comme « mauvais modèle »). Jointure quota-cli possible. Nouvelle spec `stats` à écrire avant implémentation.
