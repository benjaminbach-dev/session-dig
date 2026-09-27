# Design — add-pi-adapter

## D0 — Ce que ce change est et n'est pas

Corpus **fusionné** : deux sources, un corpus, une recherche. La fusion se fait à l'ingestion (archive), pas à la requête — les index restent des vues jetables sur le corpus unique. Ce change est la condition préalable au partage réel entre agents : le serveur MCP (`add-mcp-server`) exposera ce corpus tel quel, aucune réconciliation à la lecture.

Format de référence observé (échantillons successifs : 63 fichiers à la spécification, 83 à l'épinglage D7, 85 à la validation finale — `/root/.pi/agent/sessions/--<cwd-encodé>--/*.jsonl`) :

```
{"type":"session","version":3,"id":"<uuid7>","timestamp":"ISO","cwd":"/root"}
{"type":"model_change","id":"…","parentId":…,"timestamp":"ISO","provider":"…","modelId":"…"}
{"type":"message","id":"…","parentId":"…","timestamp":"ISO","message":{
  "role":"user|assistant|system",
  "content":[{"type":"text|thinking|toolCall",…}],
  "provider":"…","model":"…","usage":{input,output,reasoning,cacheRead,cacheWrite,cost:{total,…}},
  "timestamp":<ms epoch>}}
{"type":"message","id":"…","parentId":"…","timestamp":"ISO","message":{
  "role":"toolResult","toolCallId":"…","toolName":"…","content":[{"type":"text","text":"…"}],"isError":…,"timestamp":<ms>}}
{"type":"message","id":"…","parentId":"…","timestamp":"ISO","message":{
  "role":"bashExecution","command":"…","output":"…","exitCode":0,"cancelled":false,"truncated":false,"timestamp":<ms>}}
```

`bashExecution` est **plat** (pas de `content`, pas de `toolCallId`) — cf. D4/D7-1. Autres types observés : `session_info` (titre), `context_edit`, `compaction`, `branch_summary`, `custom`, `custom_message`, `thinking_level_change`.

## D1 — Namespacing : `source` + préfixe `pi:`

Deux espaces d'id cohabitent (UUIDv7 pi, ids opencode). Leurs formats sont distincts **aujourd'hui**, rien ne le garantit demain — et une collision écraserait un shard (`events/<md5(sessionId)>.jsonl`) ou une preuve (`raw/`).

Décision : les ids pi sont préfixés à l'adaptation — sessionId devient `pi:<uuid source>` ; **l'id d'événement est qualifié par session** : `pi:<sessionId>:<id de ligne>` (UUID de session sans préfixe additionnel — l'id étant déjà ouvert par `pi:`). Motif, constaté en validation réelle (27/09) : les ids de lignes pi ne sont **pas** uniques entre fichiers — 20 ids partagés entre deux sessions liées d'un même cwd (fork/reprise), et chaque timeline doit rester archivée fidèlement ; la qualification garantit l'absence de collision d'`events.id` sans globaliser les ids. Les partIds de preuve suivent la même convention qualifiée (`pi:<sessionId>:<id local>`, où `<sessionId>` est l'UUID de session pi sans préfixe — le partId étant déjà ouvert par `pi:`). Les ids opencode restent nus. Le corpus en place n'est donc **pas réécrit** ; le préfixe est un choix d'adaptateur, invisible pour le cœur. Toute ligne session/événement **produite après ce change** porte un champ `source` (`"pi"`/`"opencode"`) — les lignes héritées opencode ne sont pas réécrites pour seule addition du champ et sont lues comme opencode ; une ligne opencode modifiée ultérieurement est réécrite avec le champ. Le filtre `--source` et les stats s'appuient sur ce champ, jamais sur une devine de format. Pas de bump de `schemaVersion` (lecture rétro-compatible). La stabilité octet par octet du scénario « Ordre stable » s'apprécie pour un **même ensemble de sources** et les mêmes règles de sérialisation — comparer un corpus mono-source hérité à une reconstruction multi-source n'est pas une régression.

Conséquence UX : `sdig read pi:01a0dc42-…` — l'id complet, préfixe compris, est l'adresse canonique.

## D2 — État incrémental multi-source

Le watermark unique `{message, session}` (epoch ms sur `time_updated`) est propre à SQLite opencode. Pi est un répertoire de fichiers append-only : pas d'horloge globale, l'unité de changement est **le fichier**.

```
state.json multi-source (extrait) — le layoutVersion reste celui du layout de corpus :
  "layoutVersion": 2,
  "sources": {
    "opencode": { "path": "…/opencode.db", "message": …, "session": … },
    "pi":       { "path": "…/.pi/agent/sessions",
                  "files": { "<relPath>": { "size": …, "mtimeMs": … } } }
  }
```

- **Pi, grain = fichier** : un fichier dont `size` et `mtimeMs` sont inchangés est ignoré (O(stat), pas de lecture). Un fichier changé est **relu intégralement** — pas de reprise à l'octet. Motifs : (a) le raccrochage des résultats d'outils (D4) exige de voir l'appel et son résultat, qui peuvent précéder l'offset ; (b) le merge par id dans le staging de shard est idempotent, une relecture ne peut pas dupliquer ; (c) les fichiers pi sont de taille modeste (63 fichiers observés) — l'optimisation à l'octet n'achète rien à cette échelle et coûte des états intermédiaires crashables. L'état n'est pas une preuve d'invariance (réécriture à taille et mtime identiques indétectable) — c'est un déclencheur de relecture ; la relecture intégrale du moindre changement est le filet de sécurité. Fichier disparu (session supprimée) : retiré de `files`, les shards restent (archive — la suppression n'est pas propagée, cohérent avec le rôle d'archive).
- **Acquit seul des octets lus** : la taille enregistrée est celle du dernier octet de la dernière ligne **terminée** ; une ligne finale non terminée (sans terminateur) n'est pas acquittée — le prochain changement du fichier la relit complète. L'état est mesuré **après** lecture : si le fichier a grandi pendant la lecture, la divergence au prochain passage déclenche une relecture ; un octet jamais lu n'est jamais acquis. Une ligne **terminée** au JSON invalide = échec explicite, sans corpus partiellement écrit — la tolérance ne couvre que la ligne finale non terminée.
- **Changement de chemin d'une source** : l'état enregistre le chemin ; un re-pointage (`--db`, `--pi-dir`, env) invalide l'état de la source concernée seule (relecture intégrale, signalée), sans toucher l'autre.
- **Nouveau fichier** : session inconnue → ingestion complète.
- **Fichier raccourci ou `size` stockée > `size` réelle** : réécriture — relecture intégrale, même règle.
- **Ligne finale non terminée** (session vivante en cours d'écriture) : ignorée sans erreur, octets non acquittés ; à la passe suivante, `size` a changé → relecture, la ligne complète entre alors. Le marqueur de troncation corpus n'est pas mobilisé : la ligne n'a jamais été publiée.
- **Fraîcheur pi** (jeton, pas juste un compte de fichiers — un compte ne détecte ni la croissance d'un fichier, ni une suppression compensée par une création) : condensat déterministe (md5) de l'ensemble **trié** des entrées `files` (`relPath\0size\0mtimeMs`), stocké dans `state.json` et dans la table `watermark` de la vue, une ligne par source (`source`, jeton ; opencode conserve `message`/`session`). La comparaison fraîcheur (vue vs state) devient per-source : une vue en retard sur une source est en retard, point. Un jeton pi n'a **pas d'ordre** — un fichier manifeste changé rend la vue périmée, jamais « en avance » ou « en retard ». Crash entre COMMIT de la vue et state.json (vue pi COMMITée, état antérieur) : à la passe suivante, la divergence de jeton — dans un sens comme dans l'autre — déclenche une **reconstruction déterministe de la vue depuis les shards** (vérité de l'archive), suivie de l'écriture idempotente de l'état ; entre le crash et cette réconciliation, la lecture refuse la vue (sémantique « vue indisponible » existante). Cette indisponibilité temporaire des lectures pi est **documentée et acceptée** (fenêtre de crash minuscule, corpus local, refresh rapide) ; un manifeste de génération pour distinguer « vue en avance » d'une divergence arbitraire relève d'un futur change si l'indisponibilité devenait gênante. `--recover` reconstruit l'index depuis les shards et **conserve le dernier état source connu** ; les `{size, mtimeMs}` pi ne sont pas dérivables des shards — l'état pi est réconcilié par la prochaine ingestion, qui relit intégralement les fichiers changés depuis l'état conservé.
- **Migration d'état** : un `state.json` plat (top-level `message`/`session`) est interprété comme `sources.opencode` (le champ `source` actuel le confirme) et réécrit en forme multi-source au COMMIT de la première ingestion qui suit. Aucune re-ingestion forcée : les watermarks opencode sont conservés tels quels ; le delta opencode suivant est nul si sa base est inchangée.
- Le protocole de publication (marqueur → staging `.new` → renames → COMMIT de la vue → state.json) est inchangé et couvre le delta des **deux** sources en une seule passe : `--recover` et `sweepTemporaries` n'ont pas à savoir combien de sources existent.

## D3 — Registre de sources et sélection

- Défaut : `opencode` = `~/.local/share/opencode/opencode.db` ; `pi` = `~/.pi/agent/sessions`.
- `--db`/`SESSION_DIG_DB` → opencode uniquement. `--pi-dir`/`SESSION_DIG_PI_DIR` → pi uniquement. Jamais de surcharge implicite croisée.
- `--source all` (défaut) : ingeste les sources **présentes**, signale explicitement les absentes dans la sortie (« source pi absente : …/sessions — ignorée »). Pas une erreur : un environnement pi-only ou opencode-only doit fonctionner sans drapeau.
- `--source pi` (ou `opencode`) explicite : la source demandée absente = **erreur**, corpus non écrit — même garantie que la spec actuelle (« base absente »).
- `sdig status` : affiche le watermark **par source** (opencode : epoch ms ; pi : fichiers suivis, jeton de fraîcheur). En sélection `all`, si **aucune** source n'est présente : erreur explicite — jamais un corpus vide silencieux.

## D4 — Mapping pi → schéma canonique

Adaptateur `src/adapter/pi.js`, même contrat de sortie que `adaptPaged` (batches groupés par session, `{sessions, events, rawOutputs}`) — la boucle d'ingestion de `corpus.js` itère sur les adaptateurs actifs et fusionne les flux dans le même staging.

| Source pi | Canonique | Notes |
|---|---|---|
| ligne `session` | session `id=pi:<uuid>`, `directory=cwd`, `repo=basename(cwd)` | convention existante : `repo` null pour home et `/` |
| titre | dernière ligne `session_info` portant un `name` non vide dans l'ordre du fichier ; à défaut, première ligne du premier texte `user`, tronquée à 60 caractères ; à défaut, `null` | `session_info.name` est un titre fourni par pi (28 occurrences réelles). Le titre canonique alimente la ligne synthétique `role: title` de l'index, qui porte la `source` de sa session — parité de rappel préservée sur les deux chemins (ingestion et rebuild) |
| `tsCreated`/`tsUpdated` | timestamp de la 1re / dernière ligne | |
| message `role=user|assistant` | événement | autres rôles : consommés (D5) ou ignorés |
| part `text` | `text` (jointes par `\n\n`) | |
| part `thinking` | ignorée | aligne la politique v0 « parts non textuelles » (reversible par rebuild) |
| part `toolCall` | `toolCalls[] {tool=name, cmd}` | `cmd` depuis `arguments` avec la même priorité de clés que `cmdFromInput` (command, query, path, url…) |
| message `toolResult` | rattache au `toolCall` par `toolCallId` → `rawRef`, `exitCode` si exposé | contenu → `raw/pi:<sessionId>:<toolCallId>.txt` |
| message `bashExecution` | champs plats (`command`, `output`, `exitCode`, `cancelled`, `truncated`) lus directement sur `message` ; rattache **uniquement** s'il existe un appel `toolCall` bash antérieur non résolu du même fichier — le **plus récent** dans l'ordre du fichier → `cmd`, `exitCode`, `rawRef` ; sinon exécution orpheline (D5) | pas de `content` ni de `toolCallId` observés (12/12 orphelins réels) ; le rattachement reste défensif et déterministe, mais l'orphelin est le chemin observé dominant |
| `usage` | `tokens` + `cost` (`cost.total`) | correspondance directe ; messages user → zéros. **Métriques de session** : `tokens`/`cost` de la session = somme des `usage` des messages qu'elle contient (zéros si aucun) |
| `provider`/`model` | `model.providerID`/`modelID` | message-level ; absent → null |
| — | `agent` : null en v0 | les sous-agents pi sont des sessions séparées ; pas de champ agent fiable |

Ordre canonique : (`sessionId`, `ts`, `id`) — `ts` = `message.timestamp` (ms) prioritaire, repli `Date.parse(timestamp ISO)` de l'enveloppe ; une ligne où **aucune** des deux horloges n'est exploitable est un échec explicite (données incohérentes), jamais un `ts` null.

**Départage des preuves (règle unique, décidée en fin de fichier)** : un partId d'appel (`pi:<sessionId>:<toolCallId>`) n'est **jamais écrasé** — le `toolResult` porteur du `toolCallId` est autoritaire pour l'appel. Si un `bashExecution` avait été provisoirement rattaché à un appel bash et qu'un `toolResult` du même `toolCallId` apparaît ensuite, la sortie du `bashExecution` est conservée comme orpheline sous son propre id de ligne et le partId de l'appel reçoit la sortie du `toolResult`. Deux `toolResult` de même `toolCallId` : le premier fait foi, les suivants sont comptés comme orphelins sous leur id de ligne. La décision de rattachement bash est donc révisable jusqu'au terme de la lecture du fichier, pas ligne à ligne. **Aucune preuve vide** : sans sortie disponible (champ `output`/contenu absent — distinct d'une chaîne vide), ni preuve ni `rawRef` n'est émis ; l'orphelin reste compté et signalé, et un appel bash resté sans résultat en fin de fichier est compté (« appel sans preuve ») sans `rawRef` inventé. **Ids sûrs** : conserver les ids source littéraux, notamment `|`, présent dans des ids d'appels pi réels (761 occurrences) ; aucune whitelist ASCII étroite. Avant toute dérivation de shard ou de preuve, refuser un id vide ou non textuel, `/`, `\`, `:` (séparateur réservé du partId — absence confirmée dans les ids réels), les caractères de contrôle, la séquence `..` et les blancs en début ou fin ; vérifier l'unicité locale des ids de lignes et d'appels utilisés dans un même fichier (ids de lignes et d'appels partagent l'espace). Un id invalide ou une collision provoque un échec explicite avec chemin et numéro de ligne. Sur la plateforme Unix du corpus, `|` est un caractère de nom de fichier ordinaire et n'affecte ni `path.join` ni le préfixe md5 ; tout usage en shell doit citer le partId. Cette règle ne promet pas la portabilité des chemins du corpus sous Windows. **Invariant un-UUID-un-fichier** : un UUID de session identifie exactement un fichier source (vérifié sur les 85 fichiers réels) ; un UUID observé dans deux fichiers est un échec explicite, pas une fusion partielle — les métadonnées (titre, métriques, en-tête) seraient autrement republiées incomplètes. **Mémoire** : la rétention est proportionnelle aux fichiers changés et à leurs événements/preuves (relecture intégrale + tri global par session avant émission) ; acceptable à l'échelle observée (~85 fichiers, 20 Mo), à borner si l'échelle augmente.

**Types hors mapping v0** : `session_info` sert uniquement au titre (dernier `name` non vide) ; `context_edit`, `compaction`, `branch_summary`, `custom`, `custom_message`, `model_change` et `thinking_level_change` ne produisent ni événement ni texte indexé. Toute ligne de type inconnu est également ignorée **et comptée par type** dans le bilan d'ingestion, sans afficher son contenu ; un JSON terminé invalide reste une erreur (D2). Les parts de raisonnement et le rôle `system` restent ignorés. Ignorer `context_edit` ne reconstitue pas le contexte effectif après remplacement d'un message : des messages enregistrés avant l'édition peuvent rester dans le corpus et l'index — perte sémantique corrigée seulement par une évolution future de l'adaptateur suivie d'un rebuild, pas par le rebuild v0 seul.

**Branches** : l'enchaînement `parentId` forme un arbre (compactions, embranchements). En v0, aplatissement documenté : `sdig read` déroule la session par ordre temporel, branches entrelacées. C'est une **perte explicite** (une exploration abandonnée apparaît mêlée à la branche principale), acceptée parce que : (a) le grain canonique est le message ; (b) restituer l'arbre exigerait un schéma de parenté — futur change si l'éval le montre. `compaction`, `branch_summary`, `custom`, `custom_message`, `model_change`, `thinking_level_change` : ignorées, réversibles par rebuild.

## D5 — Preuves et `raw/`

- `rawRef` pi : partId = `pi:<sessionId>:<toolCallId>` — **qualifié par session** (décision fixée en spec, pas un repli d'implémentation), `<sessionId>` étant l'UUID de session pi sans préfixe : l'unicité des ids locaux n'a pas à être supposée entre fichiers, seuls des ids de session et d'appel uniques par fichier suffisent. Contenu : parts `text` du `toolResult` ; pour `bashExecution`, `output` lu directement sur `message`, sans parcourir de parts `content`. Un `rawRef` n'est ajouté que si une sortie est effectivement écrite et rattachée à un appel.
- **Exécutions orphelines** : un message de résultat sans appel correspondant — le chemin **observé dominant** du `bashExecution` (12/12 réels : commandes exécutées hors appel d'agent, sans `toolCallId` ni appel antérieur) ; la règle déterministe de rattachement de D4 reste en vigueur comme comportement défensif pour de futures sessions. La sortie **disponible** de l'orpheline est écrite dans `raw/` sous le partId `pi:<sessionId>:<id de ligne>` — l'absence éventuelle d'`output` n'impose pas une preuve vide. Aucun événement n'est créé (le grain canonique est le message user/assistant), aucun `rawRef` inventé ; le cas est compté, signalé, et les partId concernés figurent dans la sortie d'ingestion — c'est le seul canal de découverte, car le scan `--raw` ne parcourt que les preuves **référencées** par des événements (reconstruites depuis les `rawRef` dans la vue) ; les orphelines restent lisibles par `sdig raw <partId>` explicite.
- Un résultat dont l'appel vit dans un fichier déjà ingéré mais non « changé » ne devrait pas exister : tout changement déclenche la relecture **du fichier entier**, et l'appel vit dans le même fichier que son résultat. Si le cas surgit malgré tout, même règle que les orphelins : écrit, non référencé, compté, signalé.
- `--raw` (scan des sorties brutes) et `sdig raw <partId>` fonctionnent sans changement : `pi:<sessionId>:<toolCallId>` et `pi:<sessionId>:<id de ligne>` sont des partId comme les autres. Avec `--source`, le scan borne aux preuves de la source (préfixe du partId) — les preuves des autres sources ne sont pas lues.

## D6 — Sécurité et confidentialité

Lecture seule stricte du répertoire source : jamais d'écriture sous `~/.pi/`, jamais de déplacement/renommage, les sessions vivantes sont lues telles quelles (ligne non terminée ignorée, cf. D2). Le corpus reste local, jamais publié, `.gitignore` inchangé. Attention spécifique : les transcriptions pi contiennent du matériel sensible (chemins Termux, éventuels jetons) — les fixtures de test sont synthétiques, aucun extrait réel ne doit entrer dans le dépôt ; les échecs de tests n'affichent pas le contenu des sessions.

## D7 — Suppositions à vérifier avant l'implémentation (épingler ou corriger au début du change d'implémentation)

1. **`bashExecution` — validé avec réserve sur 83 fichiers réels** : rôle à champs plats (`command`, `output`, `exitCode`, `cancelled`, `truncated`), sans `content` ni `toolCallId`. Les 12 occurrences dépouillées sont orphelines : le rattachement au plus récent appel bash antérieur non résolu n'a jamais été exercé sur cet échantillon. L'orphelin est donc le chemin normal **dans cet échantillon** ; la règle D4/D5 reste le comportement défensif déterministe pour les fichiers futurs, sans prétendre à une validation empirique du rattachement. Restent à épingle : bash imbriqués, annulations `cancelled`, sous-agents.
2. **Append-only physique, non sémantique** : les lignes JSONL s'ajoutent au fichier, mais `context_edit` (`targetId`, `replacement` ; 14 occurrences réelles) peut remplacer ou retirer du contexte effectif un message antérieur. En v0 cette ligne est ignorée et comptée : le corpus archive les messages source sans appliquer ces éditions. Perte sémantique explicite, corrigeable par une future évolution de l'adaptateur suivie d'un rebuild depuis la source conservée — pas par le rebuild v0 inchangé. La relecture intégrale d'un fichier changé évite de manquer les nouvelles lignes ; elle ne résout pas cette perte.
3. **`provider`** : `message.provider` (ex. `hyper-charm`) et `model_change.provider` (ex. `opencode-go`) désignent des choses différentes. Canonique : `message.provider`/`message.model` du message assistant. À épingler sur un corpus plus large.
4. **Encodage du répertoire** : `<cwd-encodé>` n'est pas parsé — le `cwd` vient de la ligne `session` du fichier, jamais du nom de répertoire (les sessions migrées l'ont prouvé nécessaire).
5. **Unicité locale suffisante — révisée après validation réelle** : les ids de lignes ne sont **pas** uniques entre fichiers (20 ids partagés entre deux sessions réelles liées, fork/reprise) → les ids d'événement sont qualifiés par session dès la spec (D1). L'unicité des ids **au sein d'un fichier** (lignes et appels, espaces partagés) reste requise et vérifiée à l'implémentation (`claimLocal`) ; la collision au sein d'un fichier reste un échec explicite.
6. **Titre de session — validé sur l'échantillon** : `session_info.name` présent (28 occurrences réelles). Dernière occurrence à `name` non vide dans l'ordre du fichier ; sinon première ligne du premier texte user ≤ 60 caractères ; sinon `null`. Vérifier en fixture qu'un renommage met à jour la ligne synthétique `title` et son champ `source` (les deux chemins : ingestion et rebuild).

## D8 — Validation

- Suite contractuelle existante rejouée **avec fixtures pi synthétiques** : c'est le scénario « nouvel adaptateur » de la spec corpus — aucun changement du cœur attendu au-delà de l'enregistrement.
- Idempotence : double `refresh` sans changement → zéro doublon, flux inchangés octet par octet. Limite documentée : un rebuild ne reproduit le corpus que **depuis les mêmes sources** — les shards d'une source disparue (fichiers supprimés, chemin re-pointé) restent dans l'archive sans être reconstructibles, ce n'est pas une divergence de rebuild.
- Migration d'état : corpus v2 + `state.json` plat, base opencode inchangée → premier `refresh` → watermarks opencode conservés, `sources.pi` peuplé, delta opencode nul.
- Non-régression : **empreintes par fichier** (`sdig fingerprint` liste les md5 individuels) des shards opencode, avant/après la première ingestion pi → identiques ; l'empreinte **globale** change par construction (nouveaux shards pi, `state.json`, vue) et n'est pas le critère. L'ajout du champ `source` aux lignes opencode modifiées aux ingestions suivantes est accepté et documenté — il ne concerne pas cette passe.
- Vivant : fixture avec dernière ligne **non terminée** (sans terminateur) → ingestion sans erreur, ligne absente du corpus, octets non acquittés, ligne présente après complétion. Fixture distincte : ligne **terminée** au JSON invalide → échec explicite, aucun corpus partiellement écrit.
- Orphelins : fixture avec `bashExecution` direct (sans appel antérieur) → sortie dans `raw/` sous `pi:<sessionId>:<id de ligne>`, aucun `rawRef` inventé, cas compté et partId signalé dans la sortie d'ingestion ; lisible par `sdig raw` explicite, **absent** du scan `--raw` (par conception, le scan ne couvre que les preuves référencées).
- Fichier supprimé : retrait de l'état, shards conservés. Chemin de source re-pointé : invalidation de la seule source concernée.
- Registre : sélection `all` avec les deux sources absentes → erreur explicite ; une seule présente → ingestion, absence signalée.
- Fraicheur : croissance d'un fichier → jeton pi changé → vue détectée en retard ; suppression compensée par une création de même taille → jeton changé aussi (le condensat porte les chemins).
- Requête inter-sources : une requête dont la réponse attendue vit moitié dans chaque source (fixture dédiée) — le test du partage proprement dit ; `--source pi --raw` ne lit que les preuves pi référencées.
