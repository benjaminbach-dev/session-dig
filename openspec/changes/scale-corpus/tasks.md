# Tâches — scale-corpus

## Phase spec (ce change uniquement)

- [x] Écrire proposition, design (D0-D10) et deltas `corpus` + `search`.
- [x] Conserver les protections existantes : idempotence octet par octet, ordre stable, source en lecture seule, archive locale jamais publiée, index entièrement reconstruisable, sémantique de lecture inchangée.
- [x] Valider : `openspec validate scale-corpus --strict --no-interactive` et validation globale `--specs --changes --strict --no-interactive`.
- [ ] Commit/push documentaire. Aucun début d'implémentation implicite.

## Phase implémentation (change séparé, sur accord explicite)

- [ ] Adaptateur en flux (lots bornés) ; suppression de tout matérialisateur complet de la source.
- [ ] Layout v2 : shards `events/<p>/<sessionId>.jsonl` (ordre `(ts, id)`), `raw/<p>/<partId>.txt`, `layoutVersion` dans `state.json`, refus explicite des autres versions (message nommant versions lue et attendue).
- [ ] Ingest O(delta) : réécriture des seuls shards touchés, `sessions.jsonl` en O(#sessions), verrou flock contre ingestions concurrentes, écritures atomiques par fichier, convergence après interruption (testée).
- [ ] Vue dérivable étendue : JSON intégral par événement + métadonnées de sessions + FTS5 inchangé ; maintenance incrémentale pendant l'ingest ; rebuild complet déterministe conservé.
- [ ] Lecture via la vue : `read`/`--around`/`--ctx`/`--tail`/`--at` et voisins de recherche par requêtes bornées ; fraîcheur vérifiée, refus explicite si vue absente ou périmée ; logique d'ancre et de fenêtrage inchangée (tests existants repris).
- [ ] `readJsonl` en streaming partout où un parcours complet reste nécessaire ; interdiction du chargement complet sur les chemins de commande.
- [ ] `--raw` en flux : fichier par fichier, durée affichée, mémoire bornée, coût O(raw/) documenté.
- [ ] Migration v1→v2 sans source : en flux, idempotente, vérifiée (comptes annoncés, incohérences signalées).
- [ ] Empreinte déterministe du corpus (status) : md5 par fichier, chemins relatifs triés, documentée pour les conditions d'évaluation.
- [ ] Banc synthétique : générateur déterministe (graine épinglée) 100× par défaut / 1000× en option, sessions inégales dont monstres, mesures p50/p95 + empreinte mémoire consignées, hors `npm test`.

## Validation de l'implémentation future

- [ ] Suite de tests verte (sémantique inchangée) + tests dédiés : layout v2, refus de version, ingest delta (seuls les shards touchés réécrits), fenêtres bornées, mémoire bornée sur fixture, migration, empreinte stable.
- [ ] `npm run eval` 28/28 — les dorées ne bougent pas (aucun re-scoring).
- [ ] Banc 100× consigné : recherche p95, première fenêtre p95, delta d'ingestion, rebuild, empreinte mémoire — écarts aux cibles documentés et arbitrés.
- [ ] Corpus réel du téléphone migré en v2 et vérifié : comptes identiques, empreinte documentée avant/après, `read --at` revalidé sur la session n46.
- [ ] README + implementation-plan mis à jour : dépendance de `read` à la vue, commande de migration, empreinte, coûts documentés.
