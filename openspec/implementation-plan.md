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

## Phase v0.2 — évaluation sur recherches réelles — **HARNAIS PRÊT, questions à alimenter**

- ✅ `eval/queries.json` + `npm run eval` : top1/top3/top5, échecs documentés (`knownMiss`), exit 1 si miss non documenté.
- ⏳ **À faire par l'utilisateur** : ~15-20 questions d'usage réel (« je cherchais cette décision-là ») avec la session attendue. Les 5 seeds actuels sont des garde-fous de régression (titres vérifiés) ; 1 écart lexical déjà documenté (« rédiger specs console kirby » confondu avec « Affiner les specs Kirby et Pi » — candidat embeddings).
- Règle : on ne retouche pas le scoring à la main pour faire passer une question ; un manque répété arbitre les embeddings.

## Phase v1 — petit serveur MCP lecture seule (remonté, ex-v3 — retour d'agent)

- Exposer dig/read/raw en MCP (pattern agora-scout) : les agents opencode et Agora creusent l'historique eux-mêmes.
- Lecture seule, bornes de taille de résultat, politique de confidentialité à spécifier avant implémentation (SDD : nouvelle spec `mcp`).

## Phase v2 — embeddings + RRF — **conditionnés par l'évaluation**

- Retriever embeddings (chunk au message, modèle local ou API via proxy ccp) derrière la même interface + fusion RRF — seulement si l'éval v0.2 montre un manque lexical répété et documenté.

## Phase v3 — sstats — axe distinct (retour d'agent : l'exitCode n'est PAS une mesure de qualité)

- Comparaison de modèles sur usage réel : coût par problème résolu, tokens/cache par tâche, **exitCode traité comme signal d'exécution brut** (un échec peut être un diagnostic pertinent — jamais interprété seul comme « mauvais modèle »). Jointure quota-cli possible. Nouvelle spec `stats` à écrire avant implémentation.
