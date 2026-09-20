# Tâches — scale-corpus

## Phase spec (ce change uniquement)

- [x] Écrire proposition, design (D0-D10) et deltas `corpus` + `search`.
- [x] Conserver les protections existantes : idempotence octet par octet, ordre stable, source en lecture seule, archive locale jamais publiée, index entièrement reconstruisable, sémantique de lecture inchangée.
- [x] Intégrer la revue du 20/09 soir : préfixe de sharding par condensat (les identifiants partagent `ses_`/`prt_`), formule de coût honnête (delta + sessions touchées + métadonnées), protocole de publication avec COMMIT de la vue comme point de publication, fraîcheur limitée au chemin d'ingestion (empreinte pour le hors-ingestion), coût des compteurs sur la plage, preuves par blocs, banc sur parcours complet.
- [x] Valider : `openspec validate scale-corpus --strict --no-interactive` et validation globale `--specs --changes --strict --no-interactive`.
- [ ] Commit/push documentaire. Aucun début d'implémentation implicite.

## Phase implémentation (change séparé, sur accord explicite)

- [ ] Adaptateur en flux (lots bornés), **watermark en requête indexée** sur `time_updated` — pas de parcours complet des tables pour un petit delta.
- [ ] Layout v2 : shards `events/<p>/<sessionId>.jsonl` et `raw/<p>/<partId>.txt` avec `<p>` = condensat déterministe épinglé (2 hex → 256 répertoires) ; ordre `(ts, id)` ; `layoutVersion` dans `state.json` ; refus explicite des autres versions (versions lue et attendue nommées).
- [ ] Protocole de publication : staging sous noms temporaires, renames, **COMMIT de la vue en point de publication**, `state.json` en dernier, ramassage des temporaires à la passe suivante ; verrou flock contre ingestions concurrentes.
- [ ] Vue dérivable étendue : JSON intégral par événement + métadonnées de sessions + FTS5 inchangé ; maintenance incrémentale pendant l'ingest (dans la transaction de publication) ; rebuild complet déterministe conservé ; watermark de la vue porté en son sein.
- [ ] Lecture via la vue : `read`/`--around`/`--ctx`/`--tail`/`--at` et voisins de recherche par requêtes bornées (cléset `(sessionId, ts, id)`) ; compteurs exacts par dénombrement de plage ; fraîcheur vérifiée, refus explicite si vue absente ou périmée ; logique d'ancre et de fenêtrage inchangée (tests existants repris).
- [ ] `readJsonl` en streaming partout où un parcours complet reste nécessaire ; interdiction du chargement complet sur les chemins de commande.
- [ ] Preuves par blocs : `sdig raw` et `--raw` lisent par blocs bornés avec recouvrement (matches à cheval non perdus), durée affichée, mémoire indépendante de la taille des fichiers.
- [ ] Migration v1→v2 sans source : en flux, idempotente, vérifiée (comptes annoncés, incohérences signalées).
- [ ] Empreinte déterministe du corpus (status) : md5 par fichier, chemins relatifs triés, documentée pour les conditions d'évaluation et la détection hors ingestion.
- [ ] Banc synthétique : générateur déterministe (graine épinglée) 100× par défaut / 1000× en option ; sessions inégales dont monstres ; **base source synthétique à structure opencode.db réelle** ; parcours complets mesurés (recherche rendue + `--ctx`, `read --at` + compteurs, ingestion initiale + delta, preuve volumineuse) ; machine, cache chaud/froid, RSS maximale, disque temporaire consignés ; hors `npm test`.

## Validation de l'implémentation future

- [ ] Suite de tests verte (sémantique inchangée) + tests dédiés : layout v2 et répartition du condensat, refus de version, coût de passe (delta + sessions touchées ; seuls les shards touchés réécrits), fenêtres bornées, mémoire bornée sur fixture, migration, empreinte stable.
- [ ] **Tests de points de crash** : avant staging, pendant staging, entre renames, après COMMIT avant `state.json` — lectures = dernier état publié dans chaque cas, convergence à la passe suivante, temporaires ramassés, aucun travail orphelin.
- [ ] `npm run eval` 28/28 — les dorées ne bougent pas (aucun re-scoring).
- [ ] Banc 100× consigné : recherche p95 (parcours rendu), lecture `--at` + compteurs p95, delta d'ingestion, rebuild, RSS maximale — écarts aux cibles documentés et arbitrés.
- [ ] Corpus réel du téléphone migré en v2 et vérifié : comptes identiques, empreinte documentée avant/après, `read --at` revalidé sur la session n46.
- [ ] README + implementation-plan mis à jour : dépendance de `read` à la vue, commande de migration, empreinte, protocole de publication et coûts documentés.
