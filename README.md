# session-dig

**Archéologie de sessions AI.** Retrouver ce qui s'est vraiment passé dans tes sessions opencode : « c'était quoi le fix du bug de proxy en juin ? » devient une requête, pas une devine.

```
[sources]          [corpus v2]                     [retrievers]        [sortie]
opencode.db  ──►  sessions.jsonl            ──►   vue/index.db  ──►   sdig "bug proxy"
claude (v1+)      events/<p>/<ses>.jsonl          (FTS5 + JSON        --repo --after --model
zsh, git (v1+)    raw/<p>/<part>.txt               chemin de lecture)  --json
                  state.json (layoutVersion: 2)   └─ fusion RRF ─┘
```

## Principes

- **Corpus = archive, index = vue.** Le JSONL canonique (grain : le message) est la référence, immuable et versionnée (`schemaVersion`). Les index sont jetables, reconstruisables, remplaçables.
- **Adaptateurs isolés.** Chaque source (opencode en v0) a son adaptateur vers le même schéma. Le cœur ne lit jamais une source directement.
- **Retrievers derrière une interface.** FTS5/BM25 en v0, embeddings ensuite, fusion RRF déjà prévue — sans réécriture.
- **`model`, `cost`, `tokens`, `exitCode` capturés dès le départ.** Ouvre la porte aux stats de comparaison de modèles sur usage réel (v2).
- **Sorties d'outils hors corpus** (`raw/`) : le JSONL reste léger, le BM25 reste propre — seule la ligne de commande est indexée.

## Statut

**v0.6 : implémentée, passe corrective en cours — scaling non encore validé.** Layout v2 shardé par condensat md5, vue SQLite reconstruisable en chemin de lecture, fenêtres par clé et transaction de lecture ; protocole marqueur/staging/publication, migration sans source et empreinte sur les octets. Les lots courts CLI/contexte/scanner et réparation FTS sont corrigés ; **51 tests ciblés passent**. Restent notamment verrouillage concurrent, mémoire/coûts résiduels, banc fidèle et validation sur machine cible. État détaillé et reprise : [progress.md](openspec/changes/scale-corpus/progress.md), [tâches](openspec/changes/scale-corpus/tasks.md). Aucun changement du corpus réel pendant cette passe corrective.

**v0 implémentée le 16/09** (SDD : specs écrites avant le code, puis patchées aux points constatés à l'implémentation). Specs : `openspec/specs/` — [`corpus`](openspec/specs/corpus/spec.md), [`search`](openspec/specs/search/spec.md) · Plan détaillé : [`openspec/implementation-plan.md`](openspec/implementation-plan.md).

```bash
npm install          # better-sqlite3 (prebuild)
sdig refresh         # ingest incrémental + vue/index  (ou : node bin/sdig.js refresh)
sdig "bug proxy 461" --repo ccp-proxy --after 2026-06
sdig "bug proxy 461" --ctx 2        # + les messages voisins (hypothèse abandonnée ?)
sdig read <session> --around <msgId>  # dérouler la session autour du hit
sdig read <session> --around <msgId> --full  # texte intégral (marqueur de troncation sinon)
sdig read <session> --at <msgId|date>  # état À L'INSTANT de l'ancre (horodatage en UTC) : messages postérieurs masqués
sdig raw <partId>                    # la sortie d'outil complète (preuve, lecture par blocs)
sdig "connection refused" --raw     # chercher aussi dans les sorties brutes (stderr)
sdig migrate         # migration corpus v1 → layout v2, sans la source (en flux, vérifiée)
sdig fingerprint     # empreinte déterministe du corpus (intégrité / détection hors ingestion)
sdig status          # état corpus / vue
npm test             # suite complète à relancer après la passe corrective (ne remplace pas le banc)
npm run eval         # historique : 28/28 figé, 24/28 vivant ; non relancé dans cette passe
node scripts/bench.js --n 20000   # banc à corriger avant toute nouvelle conclusion de performance
```

Corpus local par défaut : `~/.local/share/session-dig/` (surchargeable `--home` ou `SESSION_DIG_HOME`) ; base source : `~/.local/share/opencode/opencode.db` en lecture seule (`--db` / `SESSION_DIG_DB`). **Changement d'usage v0.6** : `sdig read` dépend de la vue (`index.db`) — refus explicite si absente ou périmée, réparer avec `sdig refresh`.

## Roadmap

| Phase | Contenu | Statut |
|-------|---------|--------|
| v0 | adaptateur opencode + corpus + retriever FTS5 + CLI `sdig` | ✅ fait |
| v0.1 | **retrouver la décision et ses preuves** : `read`/`--ctx` (contexte), `raw` (preuve), `--raw` (stderr) | ✅ fait |
| v0.2 | évaluation sur recherches réelles (`npm run eval`) — 26 questions, **26/26 top1** après 3 améliorations motivées par l'éval (titres indexés, stopwords, OR pondéré) | ✅ fait |
| v0.3 | **jamais de coupure silencieuse** (analyse du 1er passage du jeu naturel, 19/09) : marqueur de troncation (compteurs + chemin), `--full`/`--chars N`, `--json` intégral + 2 questions brûlées en régression | ✅ fait |
| v0.4 | **évaluation traçable** (20/09) : audit déterministe des accès (`scripts/audit-toolcalls.mjs`, motifs épinglés, « à examiner », statut « audit incomplet ») + grille de notation de l'éval naturelle | ✅ fait |
| v0.5 | **ancrage temporel** (20/09) : `sdig read --at <ancre>` masque les messages postérieurs à l'instant demandé — ancre affichée, marqueur explicite, `--json` (ancre + compte) | ✅ fait |
| v1 | petit serveur MCP lecture seule : les agents creusent l'historique eux-mêmes | à venir |
| v2 | embeddings + fusion RRF — **activés seulement si l'évaluation montre un manque lexical** | conditionné |
| v3 | `sstats` : comparaison de modèles (coût, tokens ; exitCode = signal brut, pas une note) | à venir |

Corpus local uniquement — jamais publié, jamais transmis (fixtures synthétiques pour les tests).
