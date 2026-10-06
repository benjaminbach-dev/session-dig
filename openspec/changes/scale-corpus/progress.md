# Reprise — scale-corpus, passe corrective du 20/09/2026 soir

**Change NON terminé, NON archivé.** Cette fiche remplace les anciens bilans « tout coché ». Les specs décrivent la cible ; les cases rouvertes dans tasks.md sont des écarts restant à traiter. Pas de démarrage du MCP implicite. **Rescopage à la demande explicite de l'utilisateur** : jalon « usage solo local validé sur PC » en trois lots (A intégrité/prérequis, B MCP minimal + validation PC, C optimisations conditionnées aux mesures) — voir proposition ; le premier usage MCP n'attend pas la clôture complète de scale-corpus ; intégrité/reprise et exclusion d'écrivains restent bloquantes avant usage sur corpus réel. Prototypage sur fixtures permis avant le jalon. Cet encadré ne transforme pas les validations historiques ci-dessous en validations nouvelles.

## Validation PC du 01/10/2026 — A2 à A4 et bilan A5

> **Bilan HISTORIQUE, code `6af37c7`** — conservé tel quel (A1 y était partiel). La validation A1 ultérieure (PRoot, verrou noyau) fait l'objet d'une section distincte plus bas.

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

Les sections marquées « historique » conservent leurs résultats datés ; la validation A1 PRoot ci-dessous est distincte du bilan PC. Les anciennes mentions « à reprendre » ne remplacent pas la reprise opérationnelle actuelle.

## Livré dans la passe corrective — historique

- Pagination des sessions au-delà de 2 000 même sans index time_updated ; messages groupés par session, staging/fusion au fil du flux (plus de rétention de tous les événements du delta).
- Vraie transaction de lecture pour read et recherche CLI ; fenêtres par clé, contexte dense contenant le hit, métadonnées limitées aux sessions des hits.
- Lots 1/2 : CLI et imports raccordés (y compris tests/banc), retours JSON/sans résultat corrects ; raw émis en octets ; UTF-8 décodé sans coupure ; empreinte MD5 sur les octets ; scan littéral insensible à la casse Unicode, matches aux frontières et numéros de ligne, dédoublonnage.
- Vue absente/périmée : repeuplée depuis le corpus avant le delta. FTS incrémental uniquement sur vue utilisable ; sinon rebuild FTS unique en fin de passe (évite les suppressions FTS d'entrées jamais indexées).
- Rebuild depuis source : ne recharge pas l'archive v1 conservée après migration.
- Compteurs : arithmétiques en passe normale ; recomptés en réparation/réconciliation (le replay post-COMMIT ne compte pas comme un nouvel insert). recover réécrit aussi les comptes.
- buildView refuse le marqueur non réconcilié, recover prend le verrou. Verrou wx/PID : plus de reprise sur âge seul ni sur EPERM. La reprise sur ESRCH a ensuite été **retirée** au lot A1 (lire le PID puis retirer le fichier n'est pas atomique) — refus conservateur de tout verrou ambigu ; retrait manuel seulement après arrêt coordonné de tous les utilisateurs du corpus. Ce n'est pas un flock. **Remplacé au lot A1 (01/10/2026)** : le wx/PID puis le protocole « répertoire » (réfuté R1/R2) sont remplacés par un verrou noyau `better-sqlite3` (`locking_mode=EXCLUSIVE`), fichier jamais supprimé, trace commitée pour le refus conservateur — voir « Validation A1 PRoot du 01/10/2026 ».
- Nettoyage des temporaires seulement en réconciliation ; double fermeture corrigée dans streamLines quand le callback arrête la lecture.

## Validation A1 PRoot du 01/10/2026 — verrou noyau `better-sqlite3` (SOLDÉ)

**Décision.** Le protocole « répertoire `mkdir` + fichier propriétaire unique » (réfuté ci-dessous) est écarté. Le mécanisme retenu est un **verrou noyau SQLite** porté par `better-sqlite3` — **déjà une dépendance du projet** (`src/corpus.js`), donc **aucune dépendance nouvelle** à installer — avec **refus conservateur**, conformément aux specs A1/A3 (« pas de reprise automatique », verrou ambigu refusé). Aucune installation n'a été nécessaire.

**Mécanisme (`src/lock.js`).** `.ingest-lock` est une base SQLite dédiée, **jamais supprimée par le protocole**. `acquire()` : `busy_timeout=0`, `locking_mode=EXCLUSIVE`, `BEGIN EXCLUSIVE … COMMIT` — la connexion **conserve le verrou exclusif noyau** tant qu'elle est ouverte, donc l'acquisition est atomique (un second processus reçoit `SQLITE_BUSY` et refuse). Une **trace propriétaire commitée** (`lock_owner`) est lue sous le verrou : présente alors que le verrou noyau est libre ⇒ état ambigu (propriétaire mort/illisible) ⇒ **refus conservateur**, jamais de reprise automatique. `release()` supprime la trace puis ferme la connexion (le noyau libère). Un SIGKILL libère le verrou noyau à la mort du processus ; la relance ne refuse **que** si une trace commitée subsiste ou si l’init est ambigu — voir « Frontières d’arrêt brutal » ci-dessous (un crash pendant `release` après le COMMIT du DELETE laisse un état libre légitime). Reprise opérateur : retirer le fichier de verrou (et ses annexes `-journal`/`-wal`/`-shm`) **après arrêt coordonné**, jamais sous concurrence.

**Preuves — `test/lock-concurrency.test.js` (13 tests ciblés, dont des scénarios multiprocessus à barrières IPC sans délai de synchronisation) + `test/helpers/lock-child.js` :**
- **artefact ambigu refusé, intact** : répertoire, fichier **vide**, fichier illisible, **symlink** (cible inchangée), **base SQLite étrangère** (octets inchangés) ⇒ refus, aucune écriture de structure, aucun remplissage ;
- **course de première initialisation** : deux processus sur un chemin absent ⇒ un seul crée/initialise, l’autre refuse sans toucher ; trace du vainqueur commitée et intacte ; une barrière ajoutée à la revue suspend le créateur après réservation `wx`, avant initialisation : le concurrent refuse et laisse le fichier vide inchangé ;
- **schéma exact** vérifié à la revue : une table homonyme sans les contraintes attendues ou une base avec table étrangère supplémentaire est refusée octet pour octet ;
- propriétaire vivant réel ⇒ `SQLITE_BUSY`, refus ; reprise après `release` ; le **fichier de verrou n’est jamais supprimé** ;
- propriétaire mort (sortie enfant observée) ⇒ noyau libéré mais **trace commitée** ⇒ refus conservateur ; le concurrent n’efface pas la trace d’autrui ; reprise opérateur explicite ;
- deux repreneurs sur trace périmée ⇒ les deux refusent, trace intacte ;
- contention à 3 processus ⇒ exactement une acquisition, un seul `BEGIN`/`END` ;
- `acquire` idempotent ; **seconde instance du même process refusée** ; sa fermeture (jamais détentrice) ne libère pas le premier, vérifié aussi par un **concurrent tiers** ; la libération ne supprime jamais le fichier ;
- **échec d’init (`CREATE TABLE`) ou de `COMMIT`** ⇒ refus, **aucune connexion conservée** (`held:false`), artefact laissé conservateur (ambigu) puis refusé ;
- **entrelacement de libération** : barrière **avant** release (refus tant que le verrou noyau est tenu) et barrière **après le COMMIT du DELETE, avant close** (refus malgré la trace effacée ; état libre après fermeture) ;
- ingestion concurrente réelle ⇒ refus explicite, `state.json` inchangé, aucun marqueur.

**Compatibilité / dépendance :** `better-sqlite3` 13.0.3, binaire **prébuild** `linux-arm64` déjà installé (Node 24 ABI 137) — aucune compilation, aucune installation, aucun changement de `package.json`.

**Commandes/résultats (01/10/2026, Linux aarch64 PRoot, Node 24.19.0) :**
```sh
env -u NODE_OPTIONS timeout 150s node --test test/lock-concurrency.test.js              # 12/12
env -u NODE_OPTIONS timeout 200s node --test test/lock-archive.test.js test/repair.test.js  # 20/20
env -u NODE_OPTIONS timeout 300s node --test test/crash-real.test.js                    # 17/17
env -u NODE_OPTIONS timeout 200s node --test test/snapshot-real.test.js                 # 9/9
env -u NODE_OPTIONS timeout 500s npm test                                               # 280/280, 0 échec, 0 ignoré
```

**Revue et validation indépendantes (parent, Debian PRoot).** Le protocole répertoire a été rejeté, le contrat de refus des fichiers vides restauré, le schéma durci (définition exacte, aucun objet étranger) et la fenêtre réservation → initialisation testée avec une barrière IPC. Sémantique `locking_mode=EXCLUSIVE` recoupée avec la documentation officielle SQLite : les verrous persistent après transaction jusqu'à fermeture de la connexion. Après ces derniers changements :

```sh
env -u NODE_OPTIONS timeout 400s node --test --test-reporter=tap test/*.test.js
# 281/281, 0 échec, 0 ignoré ; environ 84,6 s (fixtures, pas un banc)
openspec validate scale-corpus --strict --no-interactive
openspec validate --specs --changes --strict --no-interactive
# change valide et validation globale 6/6
git diff --check
# OK
```

Aucune ingestion privée, évaluation naturelle, installation ni validation sur volume PC réel. Le cas `recover` avec temporaires résiduels reste ouvert ; ni J-MCP ni les changes ne sont déclarés clos.

**Limites honnêtes.** (1) Le noyau garantit l'exclusion **entre processus qui empruntent le verrou** ; un acteur qui **supprime le fichier de verrou hors protocole** casse l'exclusion (nouveau fichier = nouvel inode = second verrou possible) — chemin jamais emprunté par le protocole, hors contrat. (2) Aucune durabilité face à une panne matérielle. (3) `locking_mode=EXCLUSIVE` bloque aussi les **lectures** concurrentes de la base de verrou : les tests lisent la trace uniquement quand le verrou est libre (sinon existence + refus). (4) Mécanisme local (pas de multi-machine/NFS) ; journal `MEMORY` : pas d'annexe disque à interpréter, mais un crash en pleine écriture peut laisser un fichier ambigu, alors refusé conservativement.

**Frontières d'arrêt brutal (pas de promesse « tout SIGKILL laisse une trace »).** Ce qui provoque un refus conservateur à la reprise, c'est **une trace commitée** ou **un état d'init ambigu** : (a) détenteur tué avant tout `release` (trace commitée présente) ⇒ refus ; (b) tué pendant `release` **avant** le COMMIT du DELETE (trace encore présente) ⇒ refus ; (c) tué pendant l'acquisition **avant** le COMMIT de la trace, avec schéma incomplet/vide ⇒ état ambigu ⇒ refus, jamais de remplissage ; (d) tué pendant `release` **après** le COMMIT du DELETE et **avant** la fermeture ⇒ état **LIBRE légitime** (la libération était engagée ; le noyau a libéré le verrou à la mort) ⇒ le détenteur suivant acquiert ; (e) tué pendant l'acquisition avant le COMMIT de la trace avec schéma complet et sans trace ⇒ le processus n'est jamais entré dans la section protégée ⇒ état **libre**. En clair : « fichier de verrou présent » n'implique pas « refus » — seule une trace commitée ou un init ambigu refuse.

**Fichiers modifiés :** `src/lock.js`, `src/corpus.js`, `src/view.js`, `test/lock-concurrency.test.js`, `test/helpers/lock-child.js`, `test/lock-archive.test.js`, `test/crash-real.test.js`, `test/helpers/crash-child.js`, `test/snapshot-real.test.js`. Aucun corpus réel touché.

### Pourquoi le protocole « répertoire + propriétaire unique » a été écarté (justification)

**Revue parent du 01/10/2026.** Le protocole « répertoire `mkdir` + fichier propriétaire unique » (implémenté dans `src/lock.js`) **échoue au critère absolu** de A1. Deux courses ont été **reproduites déterministiquement** par barrières IPC (script de reproduction dédié, retiré après abandon du protocole ; pauses par message + lecture bloquante sur stdin, aucun délai de synchronisation) :

- **R1 — `release`/`cleanupOwnDir` retire le répertoire d'un autre.** A détient le verrou ; retrait externe du répertoire de A ; B fait `mkdir` (répertoire vide) puis se met en pause avant d'écrire son owner ; A termine son `release` : `unlink(owner-A)` est un no-op, puis `rmdir(this.path)` **réussit sur le répertoire vide de B**. Résultat reproduit : le répertoire de B est supprimé, l'écriture de l'owner de B échoue `ENOENT`. Un processus a retiré le verrou d'un autre.
- **R2 — le post-`stat` ne lie pas l'identité au `mkdir`.** A fait `mkdir` puis se met en pause avant son premier `stat` ; retrait externe du répertoire de A ; B acquiert (nouveau répertoire, owner-B) ; A reprend : son **premier `stat` lit l'identité du répertoire de B**, A écrit son owner dans ce répertoire, le second `stat` (même identité) valide. Résultat reproduit : **A et B détiennent ensemble** (deux fichiers owners dans le même répertoire). Le second `stat` compare l'identité du remplacement, pas celle du répertoire créé par A.

Sortie observée sur cet environnement (Linux aarch64 PRoot, Node 24.19.0) : R1 → le répertoire de B est supprimé par le release de A, B échoue `ENOENT` ; R2 → A et B acquièrent tous deux, **2 fichiers owners** dans le même répertoire. Le script de reproduction, spécifique au protocole écarté, a été retiré une fois celui-ci abandonné ; le mécanisme retenu (verrou noyau) n'a pas ces fenêtres.

Les tests ajoutés précédemment ne couvraient pas ces fenêtres : le test « retrait externe + réacquisition » installait le nouveau propriétaire **déjà pourvu de son owner** (donc `rmdir` → `ENOTEMPTY`, préservé) et ne pausait ni le `mkdir`→écriture de B, ni le `mkdir`→`stat` de A. Conclusion honnête : **aucune garantie absolue**, coche A1 retirée, aucun mécanisme path-only non prouvé déclaré sûr.

**Options évaluées avant ce choix.** (1) `better-sqlite3` — **retenu**, aucun ajout (dépendance déjà présente, binaire prébuild) ; (2) `flock(2)` via `fs-ext` — dépendance native à installer, **pas de prebuild publié**, `node-gyp` absent du dépôt, toolchain Termux/PRoot aarch64 incertain (non retenu ; aucun paquet installé) ; (3) `flock(1)` système (util-linux) — primitive pilotée par un processus, cycle de vie/pipe à gérer, non retenu ; (4) socket Unix abstrait (`net`) — bind noyau atomique et sans fichier, mais API **asynchrone** (refonte de `buildView`/`recover`/`migrate`/`fingerprint`), non retenu. Aucune installation n'a été faite.


### Historique — correctif PARTIEL précédent (avant remplacement du wx/PID)

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

1. **Exclusion d'écrivains et publication** : le volet verrou est **soldé au lot A1 (01/10/2026)** — verrou noyau `better-sqlite3` (`locking_mode=EXCLUSIVE`), fichier jamais supprimé, trace propriétaire commitée pour le refus conservateur (voir « Validation A1 PRoot du 01/10/2026 »). Restent : erreurs après staging, nettoyage des connexions, publication d'une nouvelle vue et durabilité.
2. **Mémoire/coûts restants** : cur.evs retient le delta d'une session entière ; sesTouched retient les sessions modifiées ; liste de renames et listShards proportionnelles au nombre de sessions. ~~rawScan fait encore `.all()` sur jusqu'à un million de références (plafond silencieux)~~ **soldé le 05/10/2026 (worker puis revue principale, voir « Passe rawScan streaming » plus bas)** ; status énumère tous les raw. ~~read complet matérialise une session~~ **soldé le 06/10/2026 (worker, voir « Passe read streaming » plus bas)** — `sdig read` parcourt les événements par itérateur paresseux. Décider bornes/streaming ; pas de promesse « mémoire indépendante partout » pour l'instant.
3. **Source** : index `time_updated` non garanti — l'ingestion SHALL exprimer le filtre watermark comme une clause SQL sur la source, **avec un scan possible selon les index et le plan choisi par SQLite** : le coût de scan possible est explicité/mesuré, jamais une promesse de plan indexé inconditionnel ni une mutation implicite de la source. Ne pas modifier la source sans accord. Vérifier snapshot source et mises à jour/suppressions ; fusion des shards suppose ts stable pour un même id. ~~La pagination 2 001 sessions a été vérifiée isolément ; ajouter un test durable dédié.~~ **Test durable ajouté le 05/10/2026** (`test/adapter-opencode-page.test.js`, 2 050 sessions, avec/sans index) puis **renforcé le 06/10/2026** (`test/adapter-source-ro.test.js` : >2050 sessions sans perte, détection PRAGMA, WAL vivant RO). **Plan SQL consigné sur PC reste ouvert.**
4. **Preuves et erreurs** : avertissement de marqueur aussi sur recherche --raw ; ne pas casser le JSON avec un avertissement stdout. ~~rawScan masque encore les erreurs de vue.~~ **précisé le 05/10/2026 (worker)** : le refus « vue absente/périmée → [] » reste volontaire, mais les erreurs DB du parcours `rawrefs` ne sont plus avalées et les erreurs de lecture de preuves sont propagées après nettoyage. Revoir refus de layout sur tous les chemins, exactitude de validation/migration et fraîcheur.
5. **Banc** : seuls les raccordements d'API sont réparés. Le rendu n'est toujours pas mesuré, la grosse preuve n'est pas générée, RSS maximale/cache froid ne sont pas prouvés ; corriger l'instrument AVANT de mesurer 500k sur PC. Les cibles restent à démontrer ; **conditionné au lot C du jalon** (banc synthétique 500k/1000× = objectif justifié, pas un prérequis du premier jalon d'usage solo local).
6. **Validation et clôture** : lots A/B de tasks.md pour J-MCP (non-régression, snapshot, interruptions/reprise, validation CLI et cliente PC). Banc étendu ensuite si nécessaire ; toute évaluation doit distinguer corpus figé et corpus vivant contaminé par les runs, sans rejeu du jeu naturel gelé non demandé. L'archivage exige validation ou report explicite des exigences restantes et arbitrage du renommage pi/scale ; le succès du MVP ne clôt pas automatiquement ce change.

## Passe rawScan streaming — 05/10/2026 (worker puis revue principale, sous-partie de la tâche composite)

**Périmètre** : uniquement `rawScan` (`src/raw.js`) et ses tests. La tâche composite « parcours globaux en streaming » reste **NON cochée** : `read` complet matérialise encore une session et les coûts Pi changé/inventaires ne sont pas mesurés.

- `rawrefs` est désormais parcouru par **itérateur paresseux** `better-sqlite3` `Statement.iterate()` — plus de `.all()` ni de `LIMIT 1000000` (plafond arbitraire supprimé) ; une seule référence transférée à la fois, `limit` borne le tableau retourné.
- **Nettoyage sur tous les chemins** (épuisement, `break` sur `limit`, erreur DB en cours d'itération, erreur de lecture d'une preuve) : `refs.return()` libère l'itérateur avant `db.close()` (sans quoi `close()` lève « busy »), le fd confiné de chaque preuve est refermé.
- **Aucun catch global** ajouté : l'erreur de lecture d'une preuve remonte telle quelle après nettoyage (comportement déjà propagé) ; seuls restent avalés les refus volontaires de `openView` (vue absente/périmée → `[]`). `openProofFd` (confinement) et l'ordre de parcours sans tri ajouté sont inchangés ; filtres source exacts et orphelines pi hors scan inchangés.
- **Preuves** (`test/raw-scan-stream.test.js`, 12 tests, fixtures tmp synthétiques) : instrumentation du prototype `Statement` (`.iterate()` utilisé, jamais `.all()` pour la requête de références, SQL sans `LIMIT`, 50 réf. + `limit 1` → 1 seul `next()` puis `return()` (arrêt AVANT la référence suivante)), nettoyage sur `break`, erreur DB injectée (l'erreur remonte, pas « busy »), erreur d'E/S de preuve propagée avec fd refermé, vue absente/périmée sans fuite de descripteurs (`/proc/self/fd`), gardes aiguille vide/source inconnue sans lecture, filtres source et orphelines, dernière référence atteinte (400 réf.).
- **Validation ciblée principale après corrections** : `node --test test/raw-scan-stream.test.js test/read.test.js test/cli-source.test.js test/multi-source.test.js test/scan-context.test.js test/cli-wiring.test.js test/cli-chrono.test.js test/read-json-warning.test.js` → **139/139** (12 nouveaux + 127 existants). OpenSpec ciblé valide et global **8/8**, `git diff --check` propre. Suite complète, banc et corpus réel non relancés (hors périmètre).
- **Limite assumée** : aucune mesure RSS dédiée (jugée fragile) ; la preuve d'absence de plafond repose sur l'instrumentation du SQL (`LIMIT` absent) et le parcours paresseux, pas sur une fixture à un million de lignes (insertion ~7 s, écartée pour éviter un test long).

**Revue principale** : arrêt dès l'ajout du dernier hit demandé (une erreur sur la référence suivante n'est plus sollicitée), nettoyage connexion en `finally` même après nettoyage de l'itérateur. Assertions directes sur `db.open === false` et fd de preuve fermé (`fstat` → `EBADF`), parcours vide/épuisé et erreur SQL avant création de l'itérateur couverts. Les erreurs SQL de préparation/parcours sont désormais propagées après nettoyage, contrairement à l'ancien `.all()` sous catch global qui les convertissait en zéro résultat ; le refus historique d'ouverture de la vue reste inchangé. Aucune garantie nouvelle d'ordre SQL sans `ORDER BY`, ni de snapshot des fichiers de preuves (ils peuvent toujours être en avance sur la vue).

## Passe read streaming — 06/10/2026 (worker, sous-partie de la tâche composite)

**Périmètre** : `sdig read` uniquement — `src/read.js` (nouveau `streamRead`), `src/format.js` (générateurs `readTerminalChunks`/`readJsonChunks` et helpers partagés), `src/util.js` (`streamToWritable`), `bin/sdig.js` (raccordement), `test/read-stream.test.js`. La tâche composite « parcours globaux en streaming » reste **NON cochée** : les coûts par fichier Pi changé et les inventaires ne sont pas mesurés.

- **Problème prouvé** : `sessionSliceDb` chargeait la session entière (`eventsAllFor`/`.all()` puis `JSON.parse` de chaque ligne) et `renderRead`/`renderReadJson` assemblaient toute la sortie avant le premier octet. Un `sdig read` sur une session géante avait donc une empreinte O(session).
- **Chemin de flux séparé, APIs tableau intactes** : `streamRead(root, sessionId, opts)` réutilise la MÊME résolution (`resolveReadWindowDb` : fenêtres keyset, ancre inclusive, compteurs de plage, `around`/`tail`/`all`, avertissements/fatals) mais rend les événements par `Statement.iterate()`, un à la fois. `sessionSlice`/`sessionSliceDb`/`renderRead`/`renderReadJson` ne changent pas de signature ni de sortie (tests existants repris tels quels) ; le rendu en flux réutilise `readHeadLines`/`readEventLine`/`readFootLines`/`readJsonEnvelope`/`readJsonMessage` partagés, donc la parité est structurelle, pas seulement testée.
- **Transaction pilotée par le générateur** : `inReadTx` est synchrone et ne peut pas attendre un consommateur asynchrone. `streamRead` fait `BEGIN` (DANS le `try` : une erreur de BEGIN laisse le `finally` refermer la connexion), revalide la fraîcheur DANS le snapshot, puis reste ouvert pendant toute la consommation (attentes de callback d'écriture comprises) et `COMMIT` ; `ROLLBACK` sur erreur ou sortie anticipée. `iter.return()` est TOUJOURS appelé AVANT `COMMIT`/`ROLLBACK` (better-sqlite3 refuse une autre instruction sur une connexion occupée par un itérateur vivant) ; une erreur de `return()` n'est pas avalée (elle empêche le COMMIT), et en erreur l'erreur d'origine prime sur l'échec de nettoyage. `db.close()` est dans le `finally`.
- **Backpressure stdout** : `streamToWritable(process.stdout)` rend `{ write, dispose }`. `write(chunk)` attend le CALLBACK de `writable.write(chunk, cb)` — un chunk en vol à la fois (backpressure naturelle) et aucune erreur tardive perdue (un `write()` rendant `true` suivi d'un callback en erreur rejette quand même la commande, jamais de succès silencieux). Une erreur `error` ou une fermeture `close` (destroy sans erreur comprise) rejette les écritures en attente et les suivantes ; `dispose()` retire les écouteurs (sink réutilisable). Une erreur d'écriture laisse stdout potentiellement partiel : le CLI sort alors en erreur (`fail`), jamais en succès silencieux.
- **Parité octet pour octet** : `test/read-stream.test.js` compare, pour `all`/`tail`/`around`/ancre/around masqué/around introuvable/pi/plain/full/chars, la sortie CLI capturée à `renderRead`/`renderReadJson` + saut de ligne — terminal ET JSON. Un bug réel a été détecté par ce test (marqueur `⋯` parasite en mode `around-masked`, spans vides) et corrigé.
- **Preuves** (`test/read-stream.test.js`, 39 tests après corrections du principal, fixtures tmp synthétiques) : parité octet terminal/JSON (11 cas × 2) ; erreurs CLI préservées (ancre invalide code 2, session inconnue code 1, stdout vide) ; instrumentation du prototype `Statement` (`mode all` → `.iterate()` du `json` des événements, jamais `.all()` ; `iter.return()` avant `COMMIT` ; connexion fermée) ; fenêtre `--tail 2` bornée (peu de `next()`) ; erreur d'itération propagée avec ROLLBACK et nettoyage ; sortie anticipée du consommateur nettoyée sans « busy » ; **publication concurrente PENDANT la consommation** (écriture COMMITée sur la vue entre deux tirages : le flux reste sur le snapshot, un nouveau lecteur voit la suite) ; `streamToWritable` (attente `drain`, aucune donnée perdue, erreur propagée, écouteur nettoyé) ; rendu en flux ≡ rendu tableau via un sink à backpressure, `[]` JSON inclus.
- **Validation worker** : suite complète `npm test` **611/611** (dont 38 nouveaux), `git diff --check` propre. **Revue principale + Advisor** : nettoyage du flux avant `fail()` (qui termine le processus sans exécuter `finally`), préservation de l'erreur d'origine même si `db.close()` échoue ; 1 test supplémentaire de fermeture. Validation principale : **84/84** tests read/snapshot/CLI avant ces retouches, puis **48/48** tests read-stream/read-json-warning après retouches. Suite globale finale consignée séparément. Aucune mesure RSS dédiée (la preuve repose sur l'instrumentation SQL et le parcours paresseux).
- **Limites assumées** : la mémoire reste bornée par la taille d'UN événement rendu (pas de promesse d'indépendance à la taille d'un événement) ; une transaction de lecture ouverte retient le snapshot WAL tant que le consommateur tire ses octets (un pipe lent retarde le checkpoint WAL — coût documenté) ; stdout peut être partiel si le flux échoue après des écritures ; coûts Pi changé/inventaires toujours non mesurés.

## Passe banc fidèle — 06/10/2026 (worker, sous-partie de la tâche composite)

**Périmètre** : `scripts/bench.js` (réécriture justifiée), `test/bench-smoke.test.js` (nouveau), docs liées. Aucun code de production, aucun retriever, aucune source réelle.

**Défauts corrigés** (prouvés par relecture) : le banc annonçait un rendu recherche+read mais ne rendait rien ; voisins non consommés et aucune transaction de lecture ; preuve « volumineuse » jamais agrandie (bucket `00` supposé) ; RSS par échantillon ponctuel ; monstre arrondi ≠ 10 % ; pas d'assertions de correction ni de nettoyage sur échec ; « cache froid (tmpfs) » proclamé sans contrôle.

**Méthode corrigée** : paramètres stricts bornés validés AVANT tmp (`--n`, `--sessions`, `--seed`, `--runs` défaut 20 min 3, `--raw-mib` défaut 16, `--keep`, `--help`) ; génération exactement `N` avec monstre `floor(N·0.10)` et partition ≥ 1 par session non-monstre ; recherche **rendue** (`renderTerminal` + voisins, ctx 3) dans `inReadTx` ; `read --at` par `streamRead` + `readTerminalChunks` vers un **sink comptage/hash** (jamais stdout) ; répétitions après échauffement, quantile **nearest-rank** avec `n` affiché ; **pic RSS OS cumulatif** `process.resourceUsage().maxRSS` ; phases init/delta/rebuild séparées ; **preuve géante insérée dans la SOURCE** (tool part) puis ingérée, lue par `streamBytes` avec **octets/md5 exacts** ; phase **fichier pi changé** (initial/append/aucun delta, bytes suivis, taille d'état, durées) ; `EXPLAIN QUERY PLAN` avec/sans index `time_updated` ; **assertions de correction** (N events/sessions, delta +1, passe vide stable, comptes/ancre, octets/hash, rendu non vide) ; **cleanup garanti** `finally`, `--keep` explicite ; disque récursif ; FS/cache **non contrôlés** annoncés.

**Smoke durable** : `test/bench-smoke.test.js` (4 tests, ~2 s) exerce le banc à petite échelle (n=100, 5 sessions, 3 runs, 1 Mio), vérifie le rapport, la preuve géante, l'EXPLAIN, le nettoyage (tmp supprimé) et le refus des arguments invalides **avant création de tmp**. Le gros banc reste hors `npm test`.

**Mesures reprises (graine 20260920, fixtures, tmpfs)** — détail [bilan 06/10](validation-pc-2026-10-06.md) : 20k ingestion 1,95 s / recherche p95 58 ms / RSS 213 Mio ; 100k ingestion 7,3 s / recherche p95 115 ms / read --at 50 ms / RSS 363 Mio ; 500k ingestion 25,4 s / recherche p95 **536 ms** (cible 100 ms **non atteinte**, écart documenté) / read --at 277 ms (50 001 msgs) / **RSS 468 Mio** (< 512) / pi append 5,3 s (fichier 11,1 Mio relu intégralement) / disque tmp 990 Mio. Cibles affichées **sans gate** ; le 500k est un point de mesure, pas une cible validée.

**Limites** : cache non contrôlé (pas de `drop_caches`), chiffres 05/10 **non comparables à méthode égale**, coût pi changé non isolé des autres coûts de passe, plans SQL synthétiques ne remplaçant pas la validation PC réelle.

## Passe source RO stricte — 06/10/2026 (worker, sous-partie « adaptateur opencode »)

**Périmètre** : `src/adapter/opencode-page.js`, `src/adapter/opencode.js`, nouveau `src/adapter/source-db.js`, `test/adapter-source-ro.test.js`, docs liées. Aucun autre travail ; aucune source réelle touchée.

- **Violation corrigée** : les deux adaptateurs repliaient sur une **copie temporaire db/-wal/-shm** quand l'ouverture échouait. Cette copie séquentielle ne garantit aucun snapshot et contredit la spec « sans jamais écrire, copier ou verrouiller durablement la base source ». Le repli est **supprimé** ; un opencode concurrent autorise réussir en RO (WAL) ou échouer proprement.
- **Module partagé** `src/adapter/source-db.js` : `new Database(dbPath, { readonly: true, fileMustExist: true })`, validation `sqlite_schema` (garbage refermé), erreur explicite **chemin + code + action** (vérifier accès/état opencode, réessayer) — jamais de conseil de suppression des fichiers source. L'ancienne API `adapt` (`opencode.js`) est conservée.
- **Détection d'index** : remplace `sqlite_master.sql.includes('time_updated')` par `pragma_index_list('session')` (index non partiels) + `pragma_index_xinfo(<nom échappé>)` (première colonne clé `time_updated`). Seule la table `session` est concernée (seule `sesQ` utilise le drapeau) ; un index sur `message`, non-tête, partiel ou une expression est écarté ; nom d'index échappé (`'` → `''`). La revue principale ajoute la preuve directe de fermeture et d'intégrité d'une source invalide, et le cas expression en tête.
- **Promesse O(delta) retirée pour les messages** : `msgQ` (`ORDER BY session_id, time_created, id`) peut scanner même avec un index `time_updated` (banc 06/10 : plan inchangé `SCAN message USING INDEX message_session_idx`) ; le plan dépend de SQLite et du coût par plage.
- **Preuves** (`test/adapter-source-ro.test.js`, 15 tests après revue principale, fixtures synthétiques) : absence/garbage/répertoire → erreur explicite et **aucune copie** (`fs.copyFileSync` instrumenté) ; détection d'index (vrai index keyset, index `message` seul, non-tête, partiel, nom avec quote) via le SQL de pagination capturé ; **>2050 sessions sans perte** en repli et avec index réel ; **source WAL vivante** lue en RO avec **db/wal inchangés** (md5 avant/après) ; **ingest sur source illisible** → aucun `state.json`/`index.db`, verrou libéré (ingestion valide suivante).
- **Revue principale + Advisor** : aucun bloquant ; libellé de refus de lecture du schéma rendu neutre (un refus RO temporaire ne signifie pas une corruption). Validation principale ciblée **53/53** avant ce dernier ajustement, puis **15/15** après.
- **Limites** : `-shm` peut être mis à jour par le protocole WAL du lecteur (fichier de coordination, pas la base) ; aucune promesse de plan indexé ; pas de test de permission OS réelle (injection par chemin non-fichier/garbage, sans `chmod`). **Plan SQL sur PC non consigné** ; aucune case composite cochée, aucun archivage.

## Reprise opérationnelle

**Dernier bilan : [validation PC partielle du 02/10/2026](validation-pc-2026-10-02.md).** Imports réels Pi et OpenCode et recherches CLI exercés sur archives dédiées ; lot B encore incomplet, défaut MCP sur commandes volumineuses reproduit et NON corrigé, client MCP réel NON testé. Le besoin de tri chronologique CLI est consigné, pas spécifié ni implémenté. Ce bilan ne clôt aucun change et ne remplace pas les preuves historiques.

Lire d'abord la **validation A1 PRoot du 01/10/2026** (section dédiée) et `git status` avant toute modification. Le bilan « Validation PC du 01/10/2026 » est **historique** (`6af37c7`, A1 alors partiel) : ne pas le réécrire. A1 est **soldé** par verrou noyau `better-sqlite3` (refus conservateur ; frontières d'arrêt brutal explicitées) ; A2–A4 restent validés sur fixtures. Des validations CLI réelles partielles ont été autorisées et réalisées le 02/10/2026 (bilan lié ci-dessus). Leurs compléments et le MVP MCP restent soumis à un nouvel accord. Les données privées restent hors Git. Aucun commit/push, démarrage ou archivage implicite.
