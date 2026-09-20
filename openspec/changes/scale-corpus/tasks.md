# Tâches — scale-corpus

> **20/09 soir — état révisé après revue et correctifs.** Change non terminé. Lire [progress.md](progress.md) pour les correctifs, preuves et limites. Les cases rouvertes ci-dessous remplacent les validations trop larges du premier bilan ; les validations historiques ne couvrent pas la passe corrective.

## Phase spec (ce change uniquement)

- [x] Écrire proposition, design (D0-D10) et deltas `corpus` + `search`.
- [x] Conserver les protections existantes : idempotence octet par octet, ordre stable, source en lecture seule, archive locale jamais publiée, index entièrement reconstruisable, sémantique de lecture inchangée.
- [x] Intégrer la revue du 20/09 soir : préfixe de sharding par condensat (les identifiants partagent `ses_`/`prt_`), formule de coût honnête (delta + sessions touchées + métadonnées), protocole de publication avec COMMIT de la vue comme point de publication, fraîcheur limitée au chemin d'ingestion (empreinte pour le hors-ingestion), coût des compteurs sur la plage, preuves par blocs, banc sur parcours complet.
- [x] Intégrer le second retour du 20/09 soir : **marqueur persistant d'ingestion en cours** (détection fiable d'un crash après le dernier rename, avant le COMMIT ; refus des opérations d'archive, réconciliation par relance, reprise explicite sans source) ; **snapshot de lecture unique** (toutes les requêtes d'une commande dans une même transaction de lecture SQLite) ; preuves en avance signalées **dans la sortie**, pas seulement dans la documentation.
- [x] Valider : `openspec validate scale-corpus --strict --no-interactive` et validation globale `--specs --changes --strict --no-interactive`.
- [x] Commit/push documentaire (f5feeb2, df33ba9, cb2f37c, a0c8091). L'implémentation a suivi, sur accord explicite, en 6104bc9.

## Phase implémentation (change séparé, sur accord explicite)

- [ ] Adaptateur en flux (lots bornés), **watermark en requête indexée** sur `time_updated` — pas de parcours complet des tables pour un petit delta.
- [x] Layout v2 : shards `events/<p>/<sessionId>.jsonl` et `raw/<p>/<partId>.txt` avec `<p>` = condensat déterministe épinglé (2 hex → 256 répertoires) ; ordre `(ts, id)` ; `layoutVersion` dans `state.json` ; refus explicite des autres versions (versions lue et attendue nommées).
- [ ] Protocole de publication : **marqueur persistant d'ingestion en cours** (posé avant tout remplacement, retiré après `state.json`), staging sous noms temporaires, renames, **COMMIT de la vue en point de publication**, `state.json`, ramassage des temporaires à la passe suivante. Tant que le marqueur est présent : avertissement sur les lectures touchant les preuves, **refus des opérations d'archive** (rebuild, empreinte, migration), réconciliation par relance, **reprise explicite** sans source (vue reconstruite, watermark conservé). Verrou flock contre ingestions concurrentes.
- [x] Vue dérivable étendue : JSON intégral par événement + métadonnées de sessions + FTS5 inchangé ; maintenance incrémentale pendant l'ingest (dans la transaction de publication) ; rebuild complet déterministe conservé ; watermark de la vue porté en son sein.
- [ ] Lecture via la vue : `read`/`--around`/`--ctx`/`--tail`/`--at` et voisins de recherche par requêtes bornées (cléset `(sessionId, ts, id)`) ; compteurs exacts par dénombrement de plage ; fraîcheur vérifiée, refus explicite si vue absente ou périmée ; **toutes les requêtes d'une commande dans une unique transaction de lecture (snapshot)** ; avertissement preuves quand le marqueur est présent ; logique d'ancre et de fenêtrage inchangée (tests existants repris).
- [ ] `readJsonl` en streaming partout où un parcours complet reste nécessaire ; interdiction du chargement complet sur les chemins de commande.
- [ ] Preuves par blocs : `sdig raw` et `--raw` lisent par blocs bornés avec recouvrement (matches à cheval non perdus), durée affichée, mémoire indépendante de la taille des fichiers.
- [ ] Migration v1→v2 sans source : en flux, idempotente, vérifiée (comptes annoncés, incohérences signalées).
- [ ] Empreinte déterministe du corpus (status) : md5 par fichier, chemins relatifs triés, documentée pour les conditions d'évaluation et la détection hors ingestion.
- [ ] Banc synthétique : générateur déterministe (graine épinglée) 100× par défaut / 1000× en option ; sessions inégales dont monstres ; **base source synthétique à structure opencode.db réelle** ; parcours complets mesurés (recherche rendue + `--ctx`, `read --at` + compteurs, ingestion initiale + delta, preuve volumineuse) ; machine, cache chaud/froid, RSS maximale, disque temporaire consignés ; hors `npm test`.

## Validation de l'implémentation future

- [ ] Suite de tests verte (sémantique inchangée) + tests dédiés : layout v2 et répartition du condensat, refus de version, coût de passe (delta + sessions touchées ; seuls les shards touchés réécrits), fenêtres bornées, mémoire bornée sur fixture, migration, empreinte stable.
- [ ] **Tests de points de crash** : avant staging, pendant staging, entre renames, **après le dernier rename avant COMMIT (détection par le marqueur — plus aucun `.new`)**, après COMMIT avant `state.json` — lectures = dernier état publié, opérations d'archive refusées via le marqueur, avertissement preuves, convergence à la passe suivante, temporaires ramassés, aucun travail orphelin.
- [ ] **Tests de snapshot et de reprise** : publication concurrente pendant une lecture multi-étapes (hits → voisins → compteurs) — un seul snapshot par commande, aucune génération intercalée ; reprise explicite sans source (vue reconstruite, watermark conservé, décision consignée) ; refus des opérations d'archive tant que le marqueur est présent.
- [ ] `npm run eval` : les dorées ne bougent pas — vérifié sur corpus figé pré-delta (code v2, 28/28). Sur le corpus réel, le delta du 19/09 (sessions concurrentes) déplace 4 top-1 : cause données, pas code (écart à arbitrer côté éval, aucun re-scoring).
- [ ] Banc consigné (20k/100k sur Proot téléphone ; 100×/1000× sur machine cible : `node scripts/bench.js --n 500000`). Écart documenté : recherche rendue p95 167 ms @100k sur Proot (cible 100 ms @500k, à re-mesurer sur machine cible). : recherche p95 (parcours rendu), lecture `--at` + compteurs p95, delta d'ingestion, rebuild, RSS maximale — écarts aux cibles documentés et arbitrés.
- [x] Corpus réel du téléphone migré en v2 et vérifié : comptes identiques, empreinte documentée avant/après, `read --at` revalidé sur la session n46.
- [x] README mis à jour (implementation-plan : voir change) : dépendance de `read` à la vue, commande de migration, empreinte, protocole de publication et coûts documentés.

## Passe corrective livrée — lots courts

- [x] Lots 1/2 : raccordements CLI, transaction, contexte avec hit, scanner Unicode et intégrité des octets ; tests dédiés.
- [x] Réparation FTS sur vue absente/périmée + delta ; pas de réimport v1 en rebuild source.
- [x] Compteurs recomptés en réconciliation/réparation ; recover restaure les comptes.
- [x] Verrou : refus de reprise d'un propriétaire vivant sur âge seul ; ESRCH seulement (courses encore ouvertes).
- [x] Arrêt anticipé streamLines sans double fermeture.
- [x] Validation légère : 51/51 (commande dans progress.md), aucun corpus réel modifié.
- [ ] Validation finale des exigences rouvertes, campagne de concurrence/crash, banc corrigé puis passage machine cible.
