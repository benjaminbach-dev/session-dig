# Reprise — scale-corpus, passe corrective du 20/09/2026 soir

**Change NON terminé, NON archivé.** Cette fiche remplace les anciens bilans « tout coché ». Les specs décrivent la cible ; les cases rouvertes dans tasks.md sont des écarts restant à traiter. Pas de démarrage du MCP implicite. **Rescopage à la demande explicite de l'utilisateur** : jalon « usage solo local validé sur PC » en trois lots (A intégrité/prérequis, B MCP minimal + validation PC, C optimisations conditionnées aux mesures) — voir proposition ; le premier usage MCP n'attend pas la clôture complète de scale-corpus ; intégrité/reprise et exclusion d'écrivains restent bloquantes avant usage sur corpus réel. Prototypage sur fixtures permis avant le jalon. Cet encadré ne transforme pas les validations historiques ci-dessous en validations nouvelles.

## Validation PC du 01/10/2026 — A2 à A4 et bilan A5

Code livré et poussé : `6af37c7` (correction de la fixture home en `36a1fd5`). Environnement de validation : Linux x64, Node 26.8.1, `better-sqlite3` 13.0.3. Fixtures synthétiques et répertoires jetables uniquement ; aucune ingestion personnelle, évaluation naturelle ni mesure du corpus réel PC.

- **A1 reste partiel et ouvert** : les 9 tests multiprocessus du verrou passent, mais les limites coopératives précédemment documentées restent valables. Ni reprise automatique ni atomicité face au retrait externe d'un verrou. Un SIGKILL laisse le verrou ; son retrait manuel exige l'arrêt coordonné de tous les utilisateurs du corpus, jamais une simple décision fondée sur le PID.
- **A2 validé** : `test/lock-archive.test.js` (13 tests, dont un test de la queue IPC) vérifie les opérations réelles index/rebuild, empreinte, migration v1 et chemin déjà v2, recover, contre une ingestion concurrente. Le verrou couvre contrôles, parcours, publication et sorties sans changement ; les rebuilds imbriqués utilisent le verrou détenu sans le libérer. Refus comparés octet par octet, WAL compris (SHM transitoire exclu). Barrières IPC, aucun délai comme synchronisation.
- **A3 validé** : `test/crash-real.test.js` (17 tests) couvre 14 SIGKILL observés : opencode seul et corpus mixte, chacun aux 7 transitions ci-dessous ; 2 reprises sans sources avec watermark conservé puis convergence ; 1 régression de nettoyage/empreinte protégeant les preuves dont l'id contient `.tmp-` ou `.new-`. L'arrêt est réel, pas un état disque fabriqué. Le verrou reste refusé après l'arrêt ; le retrait opérateur dans la fixture intervient uniquement après sortie observée du seul processus utilisateur de ce corpus. Reprise avec sources puis passe vide : contenu canonique attendu, comptes exacts, pas de perte/doublon, vue égale à l'archive, temporaires nettoyés et octets publiés stables.
- **A4 validé** : `test/snapshot-real.test.js` (9 tests) publie un vrai delta pendant les commandes CLI search avec contexte et read avec ancre, en opencode seul et mixte. Les résultats complets restent de génération A, un nouveau lecteur voit B. Les 3 cas ouverture → BEGIN → COMMIT avant état distinguent opencode lisible, Pi divergent refusé et premier Pi absent de l'état publié refusé. Les 2 rebuilds autonomes utilisent des sources rendues indisponibles et des gardes d'accès, conservent archive/état octet par octet, événements, métadonnées, recherche, lecture et comptes.
- **A5 consigné** : suite complète verte et assertions/écarts recensés ici. Cocher la preuve documentaire ne clôt pas le lot A : A1 reste ouvert. Les autres exigences composites ne deviennent pas automatiquement satisfaites.

### Transitions d'interruption effectivement exercées (A3)

| Point | Barrière juste avant l'appel, puis SIGKILL |
|---|---|
| Avant staging | Écriture du marqueur : absent, aucun remplacement commencé |
| Pendant staging | Premier rename d'un temporaire `.new-` déjà écrit |
| Entre renames | Rename des métadonnées, shards déjà remplacés |
| Dernier rename avant COMMIT | `Database.exec('COMMIT')`, tous les renames déjà faits |
| Après COMMIT avant état | Écriture de `state.json.tmp-<pid>` |
| Après état avant retrait du marqueur | Suppression du marqueur |
| Temporaire d'état écrit avant publication | Rename de `state.json.tmp-<pid>` |

La détection par marqueur est vérifiée dès que des remplacements ont pu commencer. Avant sa pose, le verrou laissé par l'arrêt brutal reste le refus conservateur. La réclamation coordonnée du verrou est une action d'opérateur simulée sur fixture, pas une nouvelle fonction automatique du produit.

### Correctifs prouvés et validations

- Verrou partagé dans `src/lock.js`, acquisition avant contrôles des opérations d'archive et conservation pendant les appels imbriqués.
- Nettoyage limité aux noms temporaires du protocole (y compris état atomique et vue temporaire/WAL/SHM) ; les motifs internes d'identifiants ne provoquent ni suppression ni exclusion de l'empreinte.
- Recherche, scan `--raw` compris, avertie sous marqueur ; JSON préservé par avertissement sur stderr (`test/read-json-warning.test.js`, 3 cas de recherche ajoutés).
- Deux défauts A4 reproduits avant correction : fenêtre de fraîcheur entre openView et BEGIN, et première ligne de watermark Pi sans état publié correspondant. Revalidation dans le snapshot avant toute donnée rendue ; la tolérance opencode en avance est conservée.

Commandes exécutées :

```sh
env -u NODE_OPTIONS timeout 90s node --test test/lock-archive.test.js test/lock-concurrency.test.js
# 22/22 après contrôle A2

env -u NODE_OPTIONS timeout 120s node --test test/crash-real.test.js test/crash.test.js test/repair.test.js test/read-json-warning.test.js
# 39/39 après contrôle A3 ; le test de nettoyage a ensuite été renforcé
# pour couvrir aussi les sidecars de la vue temporaire, puis inclus dans la suite finale

env -u NODE_OPTIONS timeout 150s node --test test/snapshot-real.test.js
# 9/9 ; les gardes du rebuild ont ensuite été renforcées et incluses dans la suite finale

env -u NODE_OPTIONS timeout 180s npm test
# Validation FINALE de 6af37c7 : 277/277, 0 échec, 0 ignoré
# Durée de cette suite sur fixtures : environ 24,5 s, pas un banc de performance
```

`git diff --check` a aussi réussi. Les états fabriqués des anciens tests sont conservés comme compléments, jamais substitués à cette campagne réelle.

### Ce qui reste ouvert après cette validation

A1 et les exigences composites encore non entièrement démontrées ; mémoire/coûts et limites des parcours raw/read complets ; plan SQL et mesures sur le volume PC réel ; lot B (CLI réel puis MVP MCP/client) ; lot C conditionnel ; ordre d'archivage pi/scale. Aucun change n'est clos ou archivé. Pas de garantie de résistance à une panne matérielle ou de disponibilité permanente pendant une publication. `recover` seul ne ramasse pas les temporaires orphelins et retire le marqueur : une ingestion ultérieure sans marqueur ne déclenche donc pas ce balayage. Le cas recover avec temporaires résiduels reste à traiter/valider ; les deux scénarios recover exercés ici n'en laissent pas. Le nettoyage validé ci-dessus est celui d'une relance avec sources sous marqueur non réconcilié.

Les sections suivantes sont le bilan HISTORIQUE antérieur à cette validation PC : leurs résultats restent datés, et leurs mentions « à reprendre » ne remplacent pas le présent point de reprise.

## Livré dans la passe corrective — historique

- Pagination des sessions au-delà de 2 000 même sans index time_updated ; messages groupés par session, staging/fusion au fil du flux (plus de rétention de tous les événements du delta).
- Vraie transaction de lecture pour read et recherche CLI ; fenêtres par clé, contexte dense contenant le hit, métadonnées limitées aux sessions des hits.
- Lots 1/2 : CLI et imports raccordés (y compris tests/banc), retours JSON/sans résultat corrects ; raw émis en octets ; UTF-8 décodé sans coupure ; empreinte MD5 sur les octets ; scan littéral insensible à la casse Unicode, matches aux frontières et numéros de ligne, dédoublonnage.
- Vue absente/périmée : repeuplée depuis le corpus avant le delta. FTS incrémental uniquement sur vue utilisable ; sinon rebuild FTS unique en fin de passe (évite les suppressions FTS d'entrées jamais indexées).
- Rebuild depuis source : ne recharge pas l'archive v1 conservée après migration.
- Compteurs : arithmétiques en passe normale ; recomptés en réparation/réconciliation (le replay post-COMMIT ne compte pas comme un nouvel insert). recover réécrit aussi les comptes.
- buildView refuse le marqueur non réconcilié, recover prend le verrou. Verrou wx/PID : plus de reprise sur âge seul ni sur EPERM. La reprise sur ESRCH a ensuite été **retirée** au lot A1 (lire le PID puis retirer le fichier n'est pas atomique) — refus conservateur de tout verrou ambigu ; retrait manuel seulement après arrêt coordonné de tous les utilisateurs du corpus. Ce n'est pas un flock (best effort coopératif, non atomique).
- Nettoyage des temporaires seulement en réconciliation ; double fermeture corrigée dans streamLines quand le callback arrête la lecture.

## Lot A1 — exclusion des écrivains : correctif du verrou, couverture PARTIELLE (case A1 laissée ouverte)

**Diagnostic.** L'implémentation précédente reprenait un verrou « périmé » en lisant le PID puis en retirant le fichier (`rmSync`) avant de recréer en `wx`. Ce n'est pas atomique : un repreneur peut retirer le verrou **fraîchement installé par un autre repreneur**, les deux croyant alors le détenir. Reproduction isolée (hors dépôt, deux enfants, fenêtre élargie) : les deux enfants voient le PID mort, B installe son verrou, A le retire puis installe le sien → **double propriété confirmée** (vérification `stale` = [true, true], fichier remplacé du PID de B par celui de A).

**Correctif local minimal.** La reprise automatique a été **retirée** : `CorpusLock.acquire()` se limite à une création exclusive `wx` (atomique) ; tout échec d'ouverture (EEXIST : verrou pris, vide, illisible, répertoire, ou autre) est un **refus conservateur**, sans jamais toucher au fichier d'autrui. Un verrou dont le propriétaire est confirmé mort reste donc à retirer **manuellement**, ce qui n'est légitime qu'**après arrêt coordonné de TOUS les utilisateurs du corpus — jamais sous concurrence** (messages d'erreur mis à jour en ce sens, pour ne pas introduire par la pratique documentée la course que le correctif évite). Compléments **best effort coopératif** : `acquire()` idempotent sur la même instance (aucune atomicité promise : un retrait externe peut orpheliniser le fd) ; échec d'écriture APRÈS création → fermeture + retrait du verrou créé puis propagation (non atomique face à un retrait externe) ; `release()` ne retire le fichier que s'il est encore le nôtre (`(dev, ino)` comparés au descripteur) — cette comparaison **puis** unlink n'est **pas atomique** : entre le `stat` et le `rm`, un retrait externe suivi d'une réacquisition peut se glisser. Aucun changement du protocole de publication ni du format du corpus.

**Couverture par tests multiprocessus** (`test/lock-concurrency.test.js`, helper `test/helpers/lock-child.js`, 9 tests, au plus 4 enfants par test) — barrières IPC, aucun délai comme synchronisation, nettoyage systématique (enfants créés tués **puis attendus** avant retrait du répertoire, borne de sécurité de nettoyage) :
- verrou vide / illisible / PID non numérique / type inattendu / répertoire → refus, fichier intact ;
- propriétaire vivant réel (enfant) → refus du parent, verrou intact, reprise seulement après release ;
- propriétaire mort **dont la sortie enfant est observée** → refus conservateur, aucun retrait automatique ;
- **deux repreneurs** simultanés sur un verrou périmé → les deux refusent, fichier inchangé (l'ancien algorithme pouvait, lui, accorder le verrou) ;
- **contention réelle** de 3 processus → exactement une acquisition, un seul `BEGIN`/`END` dans la section protégée, aucun perdant n'écrit ;
- `acquire` idempotent sur la même instance ; `release` ne supprime pas le verrou d'un autre propriétaire ;
- échec d'écriture après création → verrou nettoyé, descripteur non orphelin, verrou réutilisable ;
- **ingestion concurrente** : un autre processus détient le verrou réel du corpus → `ingest` échoue explicitement, `state.json` inchangé, aucun marqueur posé, la passe reprend après libération ;
- **entrelacement contrôlé par IPC** autour de `release` (hook fs enfant différant l'unlink, sans temporisation) : refus d'un concurrent tant que le verrou est conservé, puis acquisition après unlink effectif, et re-release de l'ancien propriétaire (fd nul → no-op) qui **ne retire pas** le verrou du nouveau.

**Commande et résultat (consolidée, exécutée après les corrections).**

```sh
env -u NODE_OPTIONS timeout 180s node --test test/lock-concurrency.test.js test/repair.test.js test/crash.test.js test/cli-wiring.test.js
```

**29/29 passent** (9 verrou + 7 réparation + 6 crash + 7 CLI ; dont `verrou vivant ancien : jamais repris sur son âge`). La suite complète n'a pas été relancée (hors périmètre).

**Limites explicites (couverture partielle).** (1) La « section protégée » des tests est un journal partagé : la protection de l'entière opération (index/rebuild, migrate, fingerprint, ingestion démarrant après leur contrôle initial) reste le lot **A2**, non traité. (2) **Non-atomicité assumée** : la vérification `(dev, ino)` puis l'unlink de `release`, le nettoyage après échec d'écriture et l'idempotence `acquire` (fd potentiellement orphelin après retrait externe) ne sont **pas** atomiques face à un retrait externe suivi d'une réacquisition dans la fenêtre `stat→rm` ; la protection est un **best effort coopératif**, pas une garantie absolue. Une réutilisation d'inode après retrait/recréation reste possible et non couverte. (3) Le mécanisme n'est **pas un flock** : aucun verrou lecteur/écrivain, aucune durabilité face à une panne matérielle, aucune reprise automatique — un verrou ambigu est refusé. (4) Fichiers modifiés : `src/corpus.js`, `test/lock-concurrency.test.js`, `test/helpers/lock-child.js` (le helper n'instrumente `fs.writeSync`/`fs.rmSync` que **dans l'enfant**, pour les injections/barrières ciblées ; aucune API de test ajoutée à la production). (5) Aucun test ne touche de corpus réel ni de session privée (source Pi hermétique, répertoires jetables). (6) Conséquence assumée : un processus arrêté brutalement sans `release()` (SIGKILL) laisse `.ingest-lock` ; toute relance (`ingest`, `recover`, `migrate`) refuse alors jusqu'au retrait manuel, légitime **seulement après arrêt coordonné de tous les utilisateurs du corpus**. C'est le refus conservateur exigé ; le lot **A3** devra définir la réclamation sûre du verrou, hors périmètre de ce correctif.

## Validation légère de cette passe

Commande bornée, fixtures temporaires uniquement :

```sh
timeout 60s node --test test/repair.test.js test/scan-context.test.js test/cli-wiring.test.js test/read.test.js
```

**51/51 passent.** Dont 7 nouveaux tests de réparation (vue absente/périmée + modification événement/titre, comptes post-COMMIT, recover, verrou vivant ancien, arrêt streamLines, ancien v1 ignoré au rebuild), 17 tests scanner/contexte et 7 tests CLI. Les tests de crash ici fabriquent certains états disque : ce ne sont pas des injections SIGKILL aux points du protocole.

Suite complète, évaluation, bancs 100k/500k/1000× et campagne de crash/concurrence réelle **non relancés dans cette passe**, volontairement différés. Aucun changement du corpus réel ni de la base source. Les anciennes mesures 92/92, 28/28 figé, 24/28 vivant et p95 167 ms @100k sont historiques, pas des validations du patch courant.

## À reprendre — historique avant la validation PC du 01/10

1. **Exclusion d'écrivains et publication** : le volet verrou wx/PID (races de reprise/release, vide/illisible, propriétaire vivant/mort, acquire/release) est **couvert partiellement au lot A1 — case laissée ouverte** (reprise automatique retirée, refus conservateur, best effort coopératif non atomique, tests multiprocessus — voir section dédiée). Restent : index/fingerprint/migration protégés contre une ingestion démarrant après leur contrôle initial (A2) ; réclamation sûre du verrou après arrêt brutal (A3) ; recyclage PID documenté comme risque résiduel ; erreurs après staging, nettoyage des connexions, publication d'une nouvelle vue et durabilité. L'exclusion d'écrivains reste un **contrat** (un seul écrivain, autres mutations échouent proprement) ; wx/PID reste une implémentation partielle, pas un flock. Un verrou ambigu est refusé conservativement ; pas de reprise automatique. Fingerprint est en lecture seule mais doit être protégé contre une mutation pendant son parcours.
2. **Mémoire/coûts restants** : cur.evs retient le delta d'une session entière ; sesTouched retient les sessions modifiées ; liste de renames et listShards proportionnelles au nombre de sessions. rawScan fait encore `.all()` sur jusqu'à un million de références (plafond silencieux), status énumère tous les raw. read complet matérialise une session. Décider bornes/streaming ; pas de promesse « mémoire indépendante partout » pour l'instant.
3. **Source** : index `time_updated` non garanti — l'ingestion SHALL exprimer le filtre watermark comme une clause SQL sur la source, **avec un scan possible selon les index et le plan choisi par SQLite** : le coût de scan possible est explicité/mesuré, jamais une promesse de plan indexé inconditionnel ni une mutation implicite de la source. Ne pas modifier la source sans accord. Vérifier snapshot source et mises à jour/suppressions ; fusion des shards suppose ts stable pour un même id. La pagination 2 001 sessions a été vérifiée isolément ; ajouter un test durable dédié.
4. **Preuves et erreurs** : avertissement de marqueur aussi sur recherche --raw ; ne pas casser le JSON avec un avertissement stdout. rawScan masque encore les erreurs de vue. Revoir refus de layout sur tous les chemins, exactitude de validation/migration et fraîcheur.
5. **Banc** : seuls les raccordements d'API sont réparés. Le rendu n'est toujours pas mesuré, la grosse preuve n'est pas générée, RSS maximale/cache froid ne sont pas prouvés ; corriger l'instrument AVANT de mesurer 500k sur PC. Les cibles restent à démontrer ; **conditionné au lot C du jalon** (banc synthétique 500k/1000× = objectif justifié, pas un prérequis du premier jalon d'usage solo local).
6. **Validation et clôture** : lots A/B de tasks.md pour J-MCP (non-régression, snapshot, interruptions/reprise, validation CLI et cliente PC). Banc étendu ensuite si nécessaire ; toute évaluation doit distinguer corpus figé et corpus vivant contaminé par les runs, sans rejeu du jeu naturel gelé non demandé. L'archivage exige validation ou report explicite des exigences restantes et arbitrage du renommage pi/scale ; le succès du MVP ne clôt pas automatiquement ce change.

## Reprise opérationnelle

Lire d'abord le point « Validation PC du 01/10/2026 » ci-dessus et `git status` avant toute modification. Conserver les changements livrés en `6af37c7`, sans réécriture globale. A2–A4 sont validés sur fixtures ; A1 reste partiel et doit être traité ou arbitré explicitement avant de déclarer le lot A validé. Validation CLI réelle et MVP MCP restent soumis à un nouvel accord. Les données privées restent hors Git. Le présent recentrage ne modifie aucun code et n'autorise ni commit/push, ni démarrage, ni archivage implicite.
