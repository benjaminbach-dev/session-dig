# Plan d'implémentation session-dig

Établi le 15/09 en brainstorming. Les specs font foi (`specs/corpus`, `specs/search`) ; ce plan ordonne le travail et consigne les décisions d'architecture prises avant le code.

## Décisions consignées (15/09)

1. **Grain = le message**, pas le tour (turn). L'agrégation vers le haut est triviale, la découpe vers le bas impossible. Les regroupements (contexte d'échange) se font à l'affichage : cluster de hits par session.
2. **`model`, `cost`, `tokens`, `exitCode` capturés dès le schéma v1** — gratuit à l'ingestion, coûteux à rétro-indexer. Ouvre la porte aux stats de comparaison de modèles (v2).
3. **Sorties d'outils hors du JSONL** (`raw/`), référencées par id de part. Seule la ligne de commande (`toolCall.cmd`) est indexée par défaut : signal pur, zéro bruit BM25.
4. **Corpus normalisé entre source et index** : c'est la couture qui rend les futures sources (Claude Code, zsh, git reflog) et les futurs retrievers (embeddings) additives.
5. **CLI nommé `sdig`** — `dig` est déjà le binaire DNS ; même logique que `quota` (commande native, symlink `/usr/local/bin`).
6. **Embeddings non exclus** : le projet n'est pas contraint au contexte proot/Termux ; le retriever BM25 est le maillon v0, pas une limite. L'interface `Retriever` est le contrat commun.

## Phase v0 — le prototype

1. **Adaptateur opencode** (Node, `better-sqlite3`, ouverture `mode=ro`) : sessions + messages + parts → `sessions.jsonl`, `events.jsonl`, `raw/`. Watermark `time_updated`, ingestion incrémentale, rebuild idempotent.
   - Source réelle vérifiée le 15/09 : `~/.local/share/opencode/opencode.db` (SQLite drizzle ; tables `session` 233, `message` 4 983, `part` 20 274 ; métriques tokens/cost dans les parts `step-finish` ; `session.directory` donne le repo).
2. **Retriever bm25** : base SQLite séparée, FTS5, colonnes filtrables (repo, session, ts, model, role, agent) ; texte user/assistant + `toolCall.cmd` indexés ; outputs jamais.
3. **CLI `sdig`** : mots-clés + filtres, sortie groupée par session avec highlight, `--json`, `--limit`.
4. **Tests** : corpus fixture synthétique commité + requêtes dorées (définition dans `specs/search`) + suite contractuelle retriever + idempotence + test de perf (~5 000 messages, cible < 100 ms/requête).

## Phase v1 — hybride

- Retriever embeddings (chunk au message, modèle local ou API via proxy ccp) derrière la même interface.
- Fusion RRF des listes de hits (documentée en spec `search`).
- Expansion de requête LLM (decorator de Query, modèle cheap via ccp-proxy).

## Phase v2 — sstats

- Comparaison de modèles sur usage réel : coût moyen par problème résolu, taux d'échec de commandes par modèle (`exitCode`), tokens/cache par tâche. Jointure avec les données quota-cli possible.
- Nouvelle spec `stats` à écrire avant implémentation (SDD).

## Phase v3 — service MCP

- Exposition du dig en serveur MCP (pattern agora-scout) : les agents opencode et Agora interrogent l'historique eux-mêmes.
- Bornes de taille de résultat et politique de confidentialité à spécifier à ce moment-là.
