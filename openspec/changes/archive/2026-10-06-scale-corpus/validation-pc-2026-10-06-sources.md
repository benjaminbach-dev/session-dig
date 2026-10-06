# Validation PC — 06/10/2026 : plan SQL et delta sur les sources personnelles réelles

**J-MCP toujours NON déclaré ; aucun change clos ni archivé.** Ce bilan comble le
trou laissé par le [bilan synthétique du même jour](validation-pc-2026-10-06.md)
(« ces plans sont synthétiques […] ne remplacent pas une validation sur la base
source réelle »). Il porte sur les **sources personnelles réelles de ce PC** :

- source opencode `~/.local/share/opencode/opencode.db` (STABLE, lue en
  lecture seule stricte via `src/adapter/source-db.js`) ;
- source pi `~/.pi/agent/sessions` (fichiers JSONL vivants, dont la session pi en
  cours qui a grossi depuis le 05/10) ;
- corpus v2 `~/.local/share/session-dig` (muté uniquement par la commande
  officielle `node bin/sdig.js refresh`).

Aucun contenu de session n'est reproduit ici : uniquement plans SQL, durées,
comptes et tailles. Aucune copie, aucun index créé dans les sources, aucun verrou
durable : la base opencode et les fichiers pi ont été lus en place.

## Environnement

Machine T14s (Manjaro, noyau 6.18.49), Node **v26.8.1**, `better-sqlite3` 13.0.3.
Source opencode réelle : fichier **5 708,4 Mo** + `-wal` vivant **242,1 Mo** (taille logique **5 986 024 192 octets** = `page_count` 1 461 377 × `page_size` 4 096). Volume logique : **2 055 sessions**,
**79 058 messages**, **335 232 parts**. Corpus v2 avant mesure : **2 368 sessions**,
**89 449 événements**, **98 398** preuves raw. Cache **non contrôlé** (aucune action
système, pas de `drop_caches`).

## Partie A — plan SQL réel de l'ingestion (lecture seule)

Requêtes extraites des adaptateurs réellement utilisés par l'ingestion :
`src/adapter/opencode-page.js` (`adaptPaged`, appelé par `src/corpus.js:501`) ;
`src/adapter/opencode.js` (`adapt`, hérité, non utilisé par l'ingestion) sert de
comparaison. La base est ouverte par `openReadonlySource` (`readonly: true`,
`fileMustExist: true`), jamais par une copie.

### Index réellement présents sur `session`

`PRAGMA index_list('session')` :

| Index | 1ʳᵉ colonne clé (`index_xinfo`) | Partiel |
|---|---|---|
| `session_workspace_idx` | `workspace_id` | non |
| `session_parent_idx` | `parent_id` | non |
| `session_project_idx` | `project_id` | non |
| `sqlite_autoindex_session_1` (pk) | `id` | non |

**Aucun index de tête sur `time_updated`.** La détection de l'adaptateur
(`hasTimeUpdatedIndex`, PRAGMA `index_list` + `index_xinfo` sur la seule table
`session`) renvoie donc **faux** sur ce PC : `adaptPaged` emprunte la **pagination
de repli par clé (`id`)** pour les sessions. Aucun index n'a été créé dans la
source.

### Plans EXACTS (`EXPLAIN QUERY PLAN`, texte complet)

| Requête (exacte) | Plan observé (id|parent|notused|detail) |
|---|---|---|
| sessions keyset (branche index — **non empruntée ici**) `SELECT * FROM session WHERE time_updated > ? AND (time_updated > ? OR (time_updated = ? AND id > ?)) ORDER BY time_updated, id LIMIT ?` | `6|0|216|SCAN session` ; `54|0|0|USE TEMP B-TREE FOR ORDER BY` |
| sessions repli **réellement utilisé** `SELECT * FROM session WHERE time_updated > ? AND id > ? ORDER BY id LIMIT ?` | `7|0|203|SEARCH session USING INDEX sqlite_autoindex_session_1 (id>?)` |
| messages du delta `SELECT * FROM message WHERE time_updated > ? ORDER BY session_id, time_created, id` | `4|0|225|SCAN message USING INDEX message_session_time_created_id_idx` |
| repo d'une session `SELECT directory FROM session WHERE id = ?` | `3|0|39|SEARCH session USING INDEX sqlite_autoindex_session_1 (id=?)` |
| parts d'un message `SELECT id, data FROM part WHERE message_id = ? ORDER BY id` | `4|0|62|SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` |
| hérité `opencode.js` `SELECT * FROM session WHERE time_updated > ?` | `2|0|216|SCAN session` |
| hérité `opencode.js` `SELECT * FROM message WHERE time_updated > ? ORDER BY time_created, id` | `3|0|216|SCAN message` ; `15|0|0|USE TEMP B-TREE FOR ORDER BY` |

### Lecture par index ou par scan ? Implication pour un delta

- **Sessions** : le plan de repli est une **recherche par index sur la clé primaire
  `id`** (`id>?`), mais le filtre `time_updated > ?` y est appliqué **après coup**
  (aucune plage sur `time_updated`). Pour trouver les sessions modifiées, la
  pagination parcourt donc la table `session` en ordre `id` jusqu'à épuisement, et
  non une plage de delta : **coût O(#sessions), pas O(delta)**. Table légère
  (2 055 lignes) → négligeable en absolu, mais la promesse « seules les sessions du
  delta sont touchées » n'est pas tenue par le plan sans index de tête.
- **Messages** : `SCAN message USING INDEX message_session_time_created_id_idx` —
  **parcours complet** de l'index d'ordre `(session_id, time_created, id)` ; le
  filtre `time_updated` s'applique après. **Coût O(#messages) = 79 058, pas
  O(delta).** C'est exactement le retrait d'O(delta) consigné au design et au
  06/10 : le plan ne dépend pas d'une intention, il **scanne**. En absolu, le
  dénombrement complet des deux tables reste court (~0 ms session, ~94 ms messages,
  ~432 ms parts, process complet 1,8 s d'ouverture+comptage).
- `repo` (par `id`) et `parts` (par `message_id`) sont des **recherches indexées**
  sur les requêtes unitaires de l'adaptateur.

**Conséquence honnête** : sur ce PC, un delta opencode est borné par la taille des
tables (index `message` parcouru entier, table `session` parcourue entière), pas par
la taille du delta. À ce volume c'est acceptable ; ce n'est pas O(delta). Aucune
correction n'est apportée ici (hors périmètre) ; le présent bilan constate le plan.

## Partie B — ingestion réelle et coûts

### Méthode

`status`/`state.json`/tailles/`du` capturés AVANT, puis
`time env -u NODE_OPTIONS node bin/sdig.js refresh` (stdout+stderr hors dépôt, dans
`/tmp`), puis re-capture APRÈS. **Deux `refresh` au total** : la passe réelle, puis
une **passe de contrôle** quasi vide (autorisée) pour séparer le coût fixe du delta.
La commande `refresh` **n'annonce pas** de durées ingest/index distinctes — une
seule ligne de bilan ; seule la durée totale est mesurée. `refresh` enchaîne
`ingest` (delta) **puis** `index()` = `buildView()` = **reconstruction complète de
la vue** (view.db supprimé, repopulation de tous les shards, `FTS rebuild`).

### AVANT

- `status` : corpus v2 ; **2 368 sessions**, **89 449 événements**, **98 398** raw ;
  watermark `message=1791138296726 session=1791138268030 (2026-10-04 18:24)` ;
  vue 89 449 événements, MAJ 2026-10-05 14:37 ; pi **313 fichiers suivis**, jeton
  `bf611ac5` ; avertissement « source pi a évolué depuis le dernier refresh »
  (attendu : la session pi en cours est un fichier vivant).
- Tailles : `index.db` **237,8 Mo** (affichage `ls`), `sessions.jsonl` **864,3 Kio**,
  `state.json` **82,4 Kio** ; `du -sh` corpus **907 Mio**.
- Marqueur : `.ingest-in-progress` **absent** (seul `.ingest-lock`, verrou normal,
  est présent). Aucune ingestion en cours.

### Passe 1 — fichier pi changé en conditions réelles

Durée totale **9,528 s** (user 7,668 / sys 2,122). Sortie :

```
refresh : +1482/3 events → corpus 90931, vue/index 90931
  pi : 343 fichier(s) suivi(s), 0 exécution(s)/résultat(s) non rattaché(s)
    lignes ignorées : model_change=38, thinking_level_change=37, role:system=52, custom=54, custom_message=11, call:bash-sans-preuve=1
```

- Delta : **+1 482 événements** ajoutés / 3 mis à jour ; **+30 sessions**
  (2 368 → 2 398) ; **+1 576 raw** (98 398 → 99 974) ; pi **313 → 343 fichiers
  suivis**.
- **Opencode : delta 0.** Le watermark publié égale déjà le max `time_updated` de la
  base réelle (Partie A) : aucun message opencode nouveau dans la fenêtre. **Tout le
  delta de cette passe vient de pi** — c'est bien le test « session pi vivante qui a
  grossi ».
- Aucune session pi vide signalée ; aucune preuve non rattachée.

### Passe 2 — contrôle quasi vide

Durée totale **8,651 s**. Sortie : `refresh : +6/1 events → corpus 90937` (pi
343 suivis). Le delta est minuscule (6 événements, ce fichier pi courant qui
continue d'écrire), mais la durée est **presque identique** à la passe 1.

### Interprétation du coût

| Passe | Delta ingéré | Sessions | Durée totale |
|---|---|---|---|
| 1 (delta pi réel) | +1 482 évt | +30 | **9,528 s** |
| 2 (contrôle, ~vide) | +6 évt | 0 | **8,651 s** |

La passe quasi vide coûte ~8,7 s : le coût est **dominé par le travail fixe
O(corpus)** de reconstruction complète de la vue (~90 937 événements, ~99 983
références raw), **pas** par le delta. Écart des deux passes ≈ **0,88 s** pour
~1 476 événements supplémentaires, soit un ordre de grandeur de **~0,6 ms/événement**
pour la partie ingestion strictement attribuable au delta (approximatif : les deux
opérations ne sont **pas isolées** par la commande).

### APRÈS (fin passe 2)

- `status` : **2 398 sessions**, **90 937 événements**, **99 983** raw ; watermark
  opencode **inchangé** ; vue 90 937, MAJ 2026-10-06 14:57 ; pi **343 fichiers**,
  jeton `1f81d70f` ; « source pi a évolué » **persiste** (le fichier vivant continue
  d'écrire après le refresh : normal, la fraîcheur de la vue se juge contre l'état
  publié, pas contre les fichiers vivants).
- Tailles : `index.db` **253,6 Mo** (237,8 → 253,6, affichage `ls`), `sessions.jsonl` **896 229 o**
  (864,3 Kio → 875,2 Kio), `state.json` **93 222 o** (82,4 → 91,0 Kio) ;
  `du -sh` corpus **923 Mio** (907 Mio avant).
- Marqueur `.ingest-in-progress` **absent** : aucune ingestion en suspens.

### Note — fichiers pi « 351 sur disque » vs « 343 suivis »

`find` compte 351 `.jsonl` non vides sous `~/.pi/agent/sessions`, mais l'état suit
**343** fichiers. Écart **8** entièrement expliqué par l'exclusion **volontaire et
documentée** du répertoire `subagent-artifacts/` dans `src/adapter/pi.js` (journaux
d'artefacts de sous-agents, hors sessions). Ce **n'est pas** une anomalie ni une
perte : `351 − 8 = 343`.

## Limites

- **Durées non isolées** : `refresh` n'annonce pas ingest vs index ; le total inclut
  la reconstruction complète de la vue. La part delta est déduite de l'écart entre
  deux passes, pas mesurée séparément.
- **Cache non contrôlé** : aucune action système ; pas de mesure à froid.
- **Opencode delta non observé en mouvement** : il valait 0 pendant la fenêtre ; son
  plan est caractérisé statiquement en Partie A, pas son coût en delta vivant.
- **Pi partiellement isolable** : la relecture intégrale d'un fichier pi changé
  reste noyée dans le coût de passe (découverte/staging/publication/rebuild).
- **Volume modeste** : 2 055 sessions / 79 k messages ; les conclusions de plan
  (scan sur `message`, table `session` parcourue) tiennent, l'impact en durée reste
  faible à cette échelle.
- Aucune donnée privée, aucun contenu de session reproduit.

## Commandes

```sh
# Partie A — lecture seule via le module du projet, jamais de copie
env -u NODE_OPTIONS node --input-type=module   # PRAGMA index_list/xinfo + EXPLAIN QUERY PLAN
# Partie B
env -u NODE_OPTIONS node bin/sdig.js status    # avant / après
time env -u NODE_OPTIONS node bin/sdig.js refresh   # passe 1 (delta pi réel), puis passe 2 (contrôle)
```
