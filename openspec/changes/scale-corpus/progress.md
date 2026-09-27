# Reprise — scale-corpus, passe corrective du 20/09/2026 soir

**Change NON terminé, NON archivé.** Cette fiche remplace les anciens bilans « tout coché ». Les specs décrivent la cible ; les cases rouvertes dans tasks.md sont des écarts restant à traiter. Pas de démarrage du MCP implicite. **Rescopage à la demande explicite de l'utilisateur** : jalon « usage solo local validé sur PC » en trois lots (A intégrité/prérequis, B MCP minimal + validation PC, C optimisations conditionnées aux mesures) — voir proposition ; le premier usage MCP n'attend pas la clôture complète de scale-corpus ; intégrité/reprise et exclusion d'écrivains restent bloquantes avant usage sur corpus réel. Prototypage sur fixtures permis avant le jalon. Cet encadré ne transforme pas les validations historiques ci-dessous en validations nouvelles.

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

1. **Exclusion d'écrivains et publication** : races de reprise simultanée/release, fichier de verrou vide/illisible, recyclage PID ; index/fingerprint/migration doivent être protégés contre une ingestion démarrant après leur contrôle initial. Tester avec plusieurs processus et vrais changements. Vérifier erreurs après staging et nettoyage des connexions, publication d'une nouvelle vue et durabilité. L'exclusion d'écrivains est un **contrat** (un seul écrivain, autres mutations échouent proprement) ; wx/PID est une implémentation partielle, pas déclarée sûre. Un verrou ambigu peut être refusé conservativement ; pas d'obligation de reprise automatique hasardeuse. Fingerprint est en lecture seule mais doit être protégé contre une mutation pendant son parcours.
2. **Mémoire/coûts restants** : cur.evs retient le delta d'une session entière ; sesTouched retient les sessions modifiées ; liste de renames et listShards proportionnelles au nombre de sessions. rawScan fait encore `.all()` sur jusqu'à un million de références (plafond silencieux), status énumère tous les raw. read complet matérialise une session. Décider bornes/streaming ; pas de promesse « mémoire indépendante partout » pour l'instant.
3. **Source** : index `time_updated` non garanti — l'ingestion SHALL exprimer le filtre watermark comme une clause SQL sur la source, **avec un scan possible selon les index et le plan choisi par SQLite** : le coût de scan possible est explicité/mesuré, jamais une promesse de plan indexé inconditionnel ni une mutation implicite de la source. Ne pas modifier la source sans accord. Vérifier snapshot source et mises à jour/suppressions ; fusion des shards suppose ts stable pour un même id. La pagination 2 001 sessions a été vérifiée isolément ; ajouter un test durable dédié.
4. **Preuves et erreurs** : avertissement de marqueur aussi sur recherche --raw ; ne pas casser le JSON avec un avertissement stdout. rawScan masque encore les erreurs de vue. Revoir refus de layout sur tous les chemins, exactitude de validation/migration et fraîcheur.
5. **Banc** : seuls les raccordements d'API sont réparés. Le rendu n'est toujours pas mesuré, la grosse preuve n'est pas générée, RSS maximale/cache froid ne sont pas prouvés ; corriger l'instrument AVANT de mesurer 500k sur PC. Les cibles restent à démontrer ; **conditionné au lot C du jalon** (banc synthétique 500k/1000× = objectif justifié, pas un prérequis du premier jalon d'usage solo local).
6. **Validation et clôture** : lots A/B de tasks.md pour J-MCP (non-régression, snapshot, interruptions/reprise, validation CLI et cliente PC). Banc étendu ensuite si nécessaire ; toute évaluation doit distinguer corpus figé et corpus vivant contaminé par les runs, sans rejeu du jeu naturel gelé non demandé. L'archivage exige validation ou report explicite des exigences restantes et arbitrage du renommage pi/scale ; le succès du MVP ne clôt pas automatiquement ce change.

## Reprise opérationnelle

Lire cette fiche et `git status` avant toute modification. Tests légers d'abord ; conserver les changements déjà livrés, pas de réécriture globale. Prochain développement éventuel : lot A ciblé, validation PC et MVP MCP sur accord ; pas de réécriture de l'architecture livrée. Les données privées restent hors Git. Le présent recentrage ne modifie aucun code et n'autorise ni commit/push, ni démarrage, ni archivage implicite.
