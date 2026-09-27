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

- [ ] Adaptateur opencode en lots, filtre watermark SQL sur `time_updated` ; vérifier le plan sur PC, signaler/mesurer un scan éventuel sans créer d'index dans la source. Relecture intégrale des fichiers Pi changés conservée, coût à mesurer.
- [x] Layout v2 : shards `events/<p>/<sessionId>.jsonl` et `raw/<p>/<partId>.txt` avec `<p>` = condensat déterministe épinglé (2 hex → 256 répertoires) ; ordre `(ts, id)` ; `layoutVersion` dans `state.json` ; refus explicite des autres versions (versions lue et attendue nommées).
- [ ] Protocole de publication : **marqueur persistant d'ingestion en cours** (posé avant tout remplacement, retiré après `state.json`), staging sous noms temporaires, renames, **COMMIT de la vue en point de publication**, `state.json`, ramassage des temporaires à la passe suivante. Tant que le marqueur est présent : avertissement sur les lectures touchant les preuves, **refus des opérations d'archive** (rebuild, empreinte, migration), réconciliation par relance, **reprise explicite** sans source (vue reconstruite, watermark conservé). Exclusion d'écrivains (contrat) : un seul écrivain, autres mutations échouent proprement — mécanisme libre (flock, wx/PID), validé par tests multi-processus.
- [x] Vue dérivable étendue : JSON intégral par événement + métadonnées de sessions + FTS5 inchangé ; maintenance incrémentale pendant l'ingest (dans la transaction de publication) ; rebuild complet déterministe conservé ; watermark de la vue porté en son sein.
- [ ] Lecture via la vue : `read`/`--around`/`--ctx`/`--tail`/`--at` et voisins de recherche par requêtes bornées (cléset `(sessionId, ts, id)`) ; compteurs exacts par dénombrement de plage ; fraîcheur vérifiée, refus explicite si vue absente ou périmée ; **toutes les requêtes d'une commande dans une unique transaction de lecture (snapshot)** ; avertissement preuves quand le marqueur est présent ; logique d'ancre et de fenêtrage inchangée (tests existants repris).
- [ ] Parcours globaux d'événements en streaming ; fenêtres/fragments sans session complète matérialisée. Coûts par fichier Pi changé, session touchée et inventaires explicités, sans promesse de mémoire universellement constante.
- [ ] Preuves par blocs : `sdig raw` et `--raw` lisent par blocs bornés avec recouvrement (matches à cheval non perdus), durée affichée, mémoire indépendante de la taille des fichiers.
- [ ] Migration v1→v2 sans source : en flux, idempotente, vérifiée (comptes annoncés, incohérences signalées).
- [ ] Empreinte déterministe du corpus (status) : md5 par fichier, chemins relatifs triés, documentée pour les conditions d'évaluation et la détection hors ingestion.
- [ ] Banc synthétique : générateur déterministe (graine épinglée) 100× par défaut / 1000× en option ; sessions inégales dont monstres ; **base source synthétique à structure opencode.db réelle** ; parcours complets mesurés (recherche rendue + `--ctx`, `read --at` + compteurs, ingestion initiale + delta, preuve volumineuse) ; machine, cache chaud/froid, RSS maximale, disque temporaire consignés ; hors `npm test`.

## Jalon et clôture (rescopage à la demande explicite de l'utilisateur)

Le premier usage MCP n'attend pas la clôture complète de scale-corpus. **J-MCP = lot A validé + lot B validé** ; le lot C est conditionnel. Le prototypage sur fixtures isolées peut précéder A. Aucune case d'implémentation ouverte n'est convertie en faite par ce recentrage.

### Lot A — avant usage sur corpus réel

- [ ] Exclusion écrivains : tests multi-processus ciblés, refus conservateur des verrous ambigus, aucun chevauchement lors des reprises/release.
- [ ] Protection de index/rebuild, migrate, recover et fingerprint pendant toute l'opération, contre une ingestion démarrant après le contrôle initial ; refus des parcours d'archive sous marqueur non réconcilié.
- [ ] Interruptions réelles aux transitions critiques staging/renames/COMMIT/état, puis reprise ; cohérence des lectures réussies ou refus explicite, aucun doublon/perte dans les fixtures. Les tests ne promettent pas la résistance à une panne matérielle.
- [ ] Snapshot unique lors d'une publication changeant les données ; opencode COMMIT avant état et divergence pi couverts distinctement ; suite de régression verte après correctifs.

### Lot B — validation CLI PC puis façade MCP

- [ ] Vérifier ingestion initiale, delta, passe sans changement et reconstruction de la vue depuis le corpus sur le volume PC réellement observé (sauvegarde ou corpus de validation distinct).
- [ ] Mesurer volume, durées, mémoire et disque avec conditions/limites de mesure ; corriger les blocages sur les chemins utilisés, sans nouveaux quotas préventifs arbitraires.
- [ ] Valider le MVP et un client réel selon `add-mcp-server/tasks.md` : search/read/status, lecture longue complète, provenance, ancrage, erreurs de fraîcheur et confidentialité. Cas mixtes sur sources présentes, sinon fixtures ; erreurs fabriquées sur copie jetable.

### Lot C — selon les observations et sur accord

- [ ] Corriger le banc avant mesures étendues si nécessaires, puis arbitrer cibles/optimisations. Extensions MCP reportées dans leur propre change, sans dépendance obligatoire pour clore scale-corpus.

L'archivage reste distinct : valider ou reporter explicitement chaque exigence restante, puis résoudre l'ordre d'archivage avec `add-pi-adapter`. Ne pas déclarer les cases restantes satisfaites par le seul succès de J-MCP.

## Validation de l'implémentation future

- [ ] Suite de tests verte (sémantique inchangée) + tests dédiés : layout v2 et répartition du condensat, refus de version, coûts de passe explicités (scan source possible ; seuls les shards touchés réécrits en passe normale), fenêtres bornées, mémoire mesurée sur fixture, migration, empreinte stable.
- [ ] **Tests de points de crash** : avant staging, pendant staging, entre renames, **après le dernier rename avant COMMIT (détection par le marqueur — plus aucun `.new`)**, après COMMIT avant `state.json` — lectures réussies cohérentes ou refus explicite (divergence pi), opérations d'archive refusées sous marqueur, avertissement preuves, reprise convergente et temporaires ramassés. Campagne ciblée du lot A, pas reportée avec la performance.
- [ ] **Tests de snapshot et de reprise** : publication concurrente pendant une lecture multi-étapes (hits → voisins → compteurs) — un seul snapshot par commande, aucune génération intercalée ; reprise explicite sans source (vue reconstruite, watermark conservé, décision consignée) ; refus des opérations d'archive tant que le marqueur est présent.
- [ ] `npm run eval` : les dorées ne bougent pas — vérifié sur corpus figé pré-delta (code v2, 28/28). Sur le corpus réel, le delta du 19/09 (sessions concurrentes) déplace 4 top-1 : cause données, pas code (écart à arbitrer côté éval, aucun re-scoring).
- [ ] Banc consigné (20k/100k sur Proot téléphone ; 100×/1000× sur machine cible : `node scripts/bench.js --n 500000`). Écart documenté : recherche rendue p95 167 ms @100k sur Proot (cible 100 ms @500k, à re-mesurer sur machine cible). Mesures attendues : recherche p95 (parcours rendu), lecture `--at` + compteurs p95, delta d'ingestion, rebuild, RSS maximale — écarts aux cibles documentés et arbitrés. **Conditionnel** (lot C du jalon) : instrument fidèle d'abord, mesures ensuite ; les cibles p95 restent des objectifs justifiés, pas des prérequis universels ; le banc 500k/1000× n'est pas exigé pour le premier jalon d'usage solo local.
- [x] Corpus réel du téléphone migré en v2 et vérifié : comptes identiques, empreinte documentée avant/après, `read --at` revalidé sur la session n46.
- [x] README mis à jour (implementation-plan : voir change) : dépendance de `read` à la vue, commande de migration, empreinte, protocole de publication et coûts documentés.

## Passe corrective livrée — lots courts

- [x] Lots 1/2 : raccordements CLI, transaction, contexte avec hit, scanner Unicode et intégrité des octets ; tests dédiés.
- [x] Réparation FTS sur vue absente/périmée + delta ; pas de réimport v1 en rebuild source.
- [x] Compteurs recomptés en réconciliation/réparation ; recover restaure les comptes.
- [x] Verrou : refus de reprise d'un propriétaire vivant sur âge seul ; ESRCH seulement (courses encore ouvertes).
- [x] Arrêt anticipé streamLines sans double fermeture.
- [x] Validation légère : 51/51 (commande dans progress.md), aucun corpus réel modifié.
- [ ] Bilan du lot B consigné sans données privées : voir critères J-MCP ci-dessus et proposition. Le jeu naturel gelé n'est jamais relancé sans demande explicite.
- [ ] Décision de clôture distincte de J-MCP : exigences vérifiées ou reports documentés, limites conservées, ordre d'archivage pi/scale résolu. Aucun archivage ni commit/push implicite.
