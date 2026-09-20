# Reprise — scale-corpus, passe corrective du 20/09/2026 soir

**Change NON terminé, NON archivé.** Cette fiche remplace les anciens bilans « tout coché ». Les specs décrivent la cible ; les cases rouvertes dans tasks.md sont des écarts restant à traiter. Pas de démarrage du MCP implicite.

## Livré dans la passe corrective

- Pagination des sessions au-delà de 2 000 même sans index time_updated ; messages groupés par session, staging/fusion au fil du flux (plus de rétention de tous les événements du delta).
- Vraie transaction de lecture pour read et recherche CLI ; fenêtres par clé, contexte dense contenant le hit, métadonnées limitées aux sessions des hits.
- Lots 1/2 : CLI et imports raccordés (y compris tests/banc), retours JSON/sans résultat corrects ; raw émis en octets ; UTF-8 décodé sans coupure ; empreinte MD5 sur les octets ; scan littéral insensible à la casse Unicode, matches aux frontières et numéros de ligne, dédoublonnage.
- Vue absente/périmée : repeuplée depuis le corpus avant le delta. FTS incrémental uniquement sur vue utilisable ; sinon rebuild FTS unique en fin de passe (évite les suppressions FTS d'entrées jamais indexées).
- Rebuild depuis source : ne recharge pas l'archive v1 conservée après migration.
- Compteurs : arithmétiques en passe normale ; recomptés en réparation/réconciliation (le replay post-COMMIT ne compte pas comme un nouvel insert). recover réécrit aussi les comptes.
- buildView refuse le marqueur non réconcilié, recover prend le verrou. Verrou wx/PID : plus de reprise sur âge seul ni sur EPERM ; ESRCH seulement. Ce n'est pas un flock.
- Nettoyage des temporaires seulement en réconciliation ; double fermeture corrigée dans streamLines quand le callback arrête la lecture.

## Validation légère de cette passe

Commande bornée, fixtures temporaires uniquement :

```sh
timeout 60s node --test test/repair.test.js test/scan-context.test.js test/cli-wiring.test.js test/read.test.js
```

**51/51 passent.** Dont 7 nouveaux tests de réparation (vue absente/périmée + modification événement/titre, comptes post-COMMIT, recover, verrou vivant ancien, arrêt streamLines, ancien v1 ignoré au rebuild), 17 tests scanner/contexte et 7 tests CLI. Les tests de crash ici fabriquent certains états disque : ce ne sont pas des injections SIGKILL aux points du protocole.

Suite complète, évaluation, bancs 100k/500k/1000× et campagne de crash/concurrence réelle **non relancés dans cette passe**, volontairement différés. Aucun changement du corpus réel ni de la base source. Les anciennes mesures 92/92, 28/28 figé, 24/28 vivant et p95 167 ms @100k sont historiques, pas des validations du patch courant.

## À reprendre (ordre recommandé)

1. **Verrou et publication** : races de reprise simultanée/release, fichier de verrou vide/illisible, recyclage PID ; index/fingerprint/migration doivent être protégés contre une ingestion démarrant après leur contrôle initial. Tester avec plusieurs processus et vrais changements. Vérifier erreurs après staging et nettoyage des connexions, publication d'une nouvelle vue et durabilité. Ne pas assimiler wx/PID à flock.
2. **Mémoire/coûts restants** : cur.evs retient le delta d'une session entière ; sesTouched retient les sessions modifiées ; liste de renames et listShards proportionnelles au nombre de sessions. rawScan fait encore `.all()` sur jusqu'à un million de références (plafond silencieux), status énumère tous les raw. read complet matérialise une session. Décider bornes/streaming ; pas de promesse « mémoire indépendante partout » pour l'instant.
3. **Source** : index time_updated non garanti, scan encore possible (et détection d'index trop permissive). Ne pas modifier la source sans accord. Vérifier snapshot source et mises à jour/suppressions ; fusion des shards suppose ts stable pour un même id. La pagination 2 001 sessions a été vérifiée isolément ; ajouter un test durable dédié.
4. **Preuves et erreurs** : avertissement de marqueur aussi sur recherche --raw ; ne pas casser le JSON avec un avertissement stdout. rawScan masque encore les erreurs de vue. Revoir refus de layout sur tous les chemins, exactitude de validation/migration et fraîcheur.
5. **Banc** : seuls les raccordements d'API sont réparés. Le rendu n'est toujours pas mesuré, la grosse preuve n'est pas générée, RSS maximale/cache froid ne sont pas prouvés ; corriger l'instrument AVANT de mesurer 500k sur PC. Les cibles restent à démontrer.
6. **Validation finale** : suite complète sous timeout sans pipeline grep/head ; vrais tests de snapshot avec publication changeant les données ; crash/reprise et reconstruction archive/view ; banc échelle après correction ; eval sur corpus figé, puis arbitrage des sessions eval-run contaminant le corpus vivant. Ne pas archiver avant ces décisions.

## Reprise opérationnelle

Lire cette fiche et `git status` avant toute modification. Tests légers d'abord ; conserver les changements déjà livrés, pas de réécriture globale. Prochain développement éventuel : durcissement ciblé ci-dessus, MCP seulement sur accord. Les données privées restent hors Git. Commit/push incluent la reprise du travail interrompu et les lots 1/2 ; pas de dépendance nouvelle.
