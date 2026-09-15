# session-dig

**Archéologie de sessions AI.** Retrouver ce qui s'est vraiment passé dans tes sessions opencode : « c'était quoi le fix du bug de proxy en juin ? » devient une requête, pas une devine.

```
[sources]          [corpus]              [retrievers]        [sortie]
opencode.db  ──►  events.jsonl    ──►   bm25 (FTS5)   ──►   sdig "bug proxy"
claude (v1+)      sessions.jsonl        embeddings(v1+)      --repo --after --model
zsh, git (v1+)    raw/ (outputs)        └─ fusion RRF ─┘     --json
```

## Principes

- **Corpus = archive, index = vue.** Le JSONL canonique (grain : le message) est la référence, immuable et versionnée (`schemaVersion`). Les index sont jetables, reconstruisables, remplaçables.
- **Adaptateurs isolés.** Chaque source (opencode en v0) a son adaptateur vers le même schéma. Le cœur ne lit jamais une source directement.
- **Retrievers derrière une interface.** FTS5/BM25 en v0, embeddings ensuite, fusion RRF déjà prévue — sans réécriture.
- **`model`, `cost`, `tokens`, `exitCode` capturés dès le départ.** Ouvre la porte aux stats de comparaison de modèles sur usage réel (v2).
- **Sorties d'outils hors corpus** (`raw/`) : le JSONL reste léger, le BM25 reste propre — seule la ligne de commande est indexée.

## Statut

**v0 implémentée le 16/09** (SDD : specs écrites avant le code, puis patchées aux points constatés à l'implémentation). Specs : `openspec/specs/` — [`corpus`](openspec/specs/corpus/spec.md), [`search`](openspec/specs/search/spec.md) · Plan détaillé : [`openspec/implementation-plan.md`](openspec/implementation-plan.md).

```bash
npm install          # better-sqlite3 (prebuild)
sdig refresh         # ingest incrémental + index  (ou : node bin/sdig.js refresh)
sdig "bug proxy 461" --repo ccp-proxy --after 2026-06
sdig "git revert"    # les commandes de toolCalls sont cherchables
sdig status          # état corpus / index
npm test             # 23 tests (dorées, contrat retriever, idempotence)
npm run bench        # 5k events : index 190 ms, requête < 11 ms
```

Corpus local par défaut : `~/.local/share/session-dig/` (surchargeable `--home` ou `SESSION_DIG_HOME`) ; base source : `~/.local/share/opencode/opencode.db` en lecture seule (`--db` / `SESSION_DIG_DB`).

## Roadmap

| Phase | Contenu |
|-------|---------|
| v0 | adaptateur opencode + corpus + retriever FTS5 + CLI `sdig` |
| v1 | retriever embeddings + fusion RRF + expansion de requête LLM |
| v2 | `sstats` : comparaison de modèles (coût, fiabilité exitCode, tokens) sur usage réel |
| v3 | serveur MCP : les agents creusent l'historique eux-mêmes |

Corpus local uniquement — jamais publié, jamais transmis (fixtures synthétiques pour les tests).
