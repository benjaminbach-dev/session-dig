# session-dig

**Archéologie de sessions AI.** Retrouver ce qui s'est vraiment passé dans tes sessions opencode : « c'était quoi le fix du bug de proxy en juin ? » devient une requête, pas une devine.

```
[sources]                 [corpus v2 multi-source]        [retrievers]        [sortie]
opencode.db   ──┐         sessions.jsonl            ──►   vue/index.db  ──►   sdig "bug proxy"
(SQLite, RO)    ├──────►  events/<p>/<ses>.jsonl          (FTS5 + JSON        --repo --after --model
~/.pi/agent/  ──┘         raw/<p>/<part>.txt               chemin de lecture)  --source pi
sessions/*.jsonl          state.json (layoutVersion: 2,   └─ fusion RRF ─┘
(JSONL, RO)               sources: opencode | pi)
```

## Principes

- **Corpus = archive, index = vue.** Le JSONL canonique (grain : le message) est la référence — **archive normalisée et versionnée** (`schemaVersion`) : la dernière version connue d'un message y remplace la précédente. Les index sont jetables, reconstruisables, remplaçables.
- **Adaptateurs isolés.** Chaque source a son adaptateur vers le même schéma (opencode en v0 ; pi en v0.7 — JSONL append-only). Le cœur ne lit jamais une source directement.
- **Provenance.** Toute ligne produite porte `source` (`opencode`/`pi`) — filtrable (`--source`), affichée (`--json`). Le corpus est une **archive multi-source** : les sources sont combinées à l'ingestion ; supprimer une source ne retire pas ses shards.
- **Retrievers derrière une interface.** FTS5/BM25 en v0, embeddings ensuite, fusion RRF prévue (futur, conditionné) — sans réécriture.
- **`model`, `cost`, `tokens`, `exitCode` capturés dès le départ.** Ouvre la porte aux stats de comparaison de modèles sur usage réel (v2).
- **Sorties d'outils hors corpus** (`raw/`) : le JSONL reste léger, le BM25 reste propre — seule la ligne de commande est indexée.

## Statut

**État actuel — 06/10/2026 :** lecture CLI en flux avec snapshot et backpressure ; banc réellement rendu, mesuré jusqu'à **500 000 événements** ; outils naturels compatibles avec la vue v2 ; adaptateurs opencode sans copie de repli et détection d'index corrigée. Validation finale : **645/645 tests**, OpenSpec **8/8**. Revues principales et Advisor effectuées ; aucune source personnelle ni jeu naturel gelé utilisé dans cette passe.

Le banc relève **468 Mio** de pic RSS cumulatif et **536 ms p95** de recherche rendue à 500k : la cible de 100 ms **n'est pas atteinte**. [Méthode et mesures](openspec/changes/scale-corpus/validation-pc-2026-10-06.md) · [reprise et restes ouverts](openspec/changes/scale-corpus/progress.md#reprise-opérationnelle). Aucun change clos/archivé et aucun J-MCP plein déclaré.

**Historique des versions :** les chiffres et restes ci-dessous décrivent leurs passes datées, pas l'état actuel.

**v0.7 : adaptateur pi + corpus fusionné — implémentée.** Deux sources dans une seule passe de publication (protocole marqueur/staging/renames/COMMIT/state inchangé) ; état `state.json` multi-source (migration de la forme plate au premier COMMIT, watermarks opencode conservés) ; jetons de fraîcheur par source (pi : md5 des fichiers suivis — toute divergence vue/état ⇒ reconstruction depuis les shards, lecture refusée entre-temps) ; `--source all|opencode|pi` et `--pi-dir` sur ingest/refresh, filtre de provenance sur la recherche et le scan `--raw` ; `sdig read pi:<sessionId>` avec l'id préfixé ; ids d'événement et de preuve **qualifiés par session** (`pi:<sessionId>:<id>` — fork/reprise rejouent les ids de lignes) ; partIds pi validés avant toute dérivation de chemin. **208 tests passent.** Restent ouverts : les limites scale-corpus ci-dessous ; les suppositions D7 (bash imbriqués, `cancelled`, sous-agents) à épingler sur sessions riches ; banc inchangé. Détail : [design](openspec/changes/add-pi-adapter/design.md).

**v0.6 : implémentée, passe corrective en cours — scaling non encore validé.** Layout v2 shardé par condensat md5, vue SQLite reconstruisable en chemin de lecture, fenêtres par clé et transaction de lecture ; protocole marqueur/staging/publication, migration sans source et empreinte sur les octets. Les lots courts CLI/contexte/scanner et réparation FTS sont corrigés ; **51 tests ciblés passent**. Restent notamment verrouillage concurrent, mémoire/coûts résiduels, banc fidèle et validation sur machine cible. État détaillé et reprise : [progress.md](openspec/changes/scale-corpus/progress.md), [tâches](openspec/changes/scale-corpus/tasks.md). Aucun changement du corpus réel pendant cette passe corrective.

**v0 implémentée le 16/09** (SDD : specs écrites avant le code, puis patchées aux points constatés à l'implémentation). Specs : `openspec/specs/` — [`corpus`](openspec/specs/corpus/spec.md), [`search`](openspec/specs/search/spec.md) · Plan détaillé : [`openspec/implementation-plan.md`](openspec/implementation-plan.md).

```bash
npm install          # better-sqlite3 (prebuild)
sdig refresh         # ingest incrémental + vue/index  (ou : node bin/sdig.js refresh)
sdig "bug proxy 461" --repo ccp-proxy --after 2026-06
sdig "bug proxy 461" --ctx 2        # + les messages voisins (hypothèse abandonnée ?)
sdig read <session> --around <msgId>  # dérouler la session autour du hit
sdig read <session> --around <msgId> --full  # texte intégral (marqueur de troncation sinon)
sdig read <session> --at <msgId|date>  # état À L'INSTANT de l'ancre (horodatage en UTC) : messages postérieurs masqués
sdig raw <partId>                    # la sortie d'outil complète (preuve, lecture par blocs)
sdig "connection refused" --raw     # chercher aussi dans les sorties brutes (stderr)
sdig "bug proxy" --source pi         # seuls les hits des sessions pi (titres compris)
sdig "bug proxy" --sort oldest --limit 20   # tri chronologique GLOBAL (ts, id binaire) : plus ancien d'abord
sdig --sort newest --role assistant --model deepseek --limit 1 --json  # dernière trace d'un modèle, SANS mots-clés
sdig --sort oldest --role user --limit 1     # plus ancien MESSAGE user du sous-ensemble canonique courant
sdig read pi:<sessionId>             # dérouler une session pi — l'id préfixé est l'adresse canonique
sdig read pi:<sessionId> --around pi:<sessionId>:<msgId> --at pi:<sessionId>:<msgId>  # ancre = id d'événement
sdig raw pi:<sessionId>:<toolCallId>  # preuve pi rattachée à un appel d'agent
sdig raw pi:<sessionId>:<ligne>       # preuve orpheline : exécution directe hors agent, signalée à l'ingestion, hors scan --raw
sdig ingest --source pi              # n'ingérer que le delta pi (absence d'une source explicite = erreur)
# ids d'événement et de preuve qualifiés par session (pi:<sessionId>:<id>) : fork/reprise rejouent les mêmes ids de lignes
sdig migrate         # migration corpus v1 → layout v2, sans la source (en flux, vérifiée)
sdig fingerprint     # empreinte déterministe du corpus (intégrité / détection hors ingestion)
sdig status          # état corpus / vue
npm test             # suite complète à relancer après la passe corrective (ne remplace pas le banc)
npm run eval         # historique : 28/28 figé, 24/28 vivant ; non relancé dans cette passe
node scripts/bench.js --n 20000 --sessions 100 --runs 10 --raw-mib 8
                     # banc synthétique fidèle (rendu réel, snapshot, preuve géante,
                     # pic RSS OS) — hors npm test ; smoke : test/bench-smoke.test.js
```

Corpus local par défaut : `~/.local/share/session-dig/` (surchargeable `--home` ou `SESSION_DIG_HOME`). Sources en lecture seule : base opencode `~/.local/share/opencode/opencode.db` (`--db` / `SESSION_DIG_DB` — **propre à opencode**, jamais appliquée à pi) ; répertoire des sessions pi `~/.pi/agent/sessions` (`--pi-dir` / `SESSION_DIG_PI_DIR`). `sdig status` affiche le watermark par source (opencode : epoch ; pi : fichiers suivis + jeton) et signale les absences. **Changement d'usage v0.6** : `sdig read` dépend de la vue (`index.db`) — refus explicite si absente ou périmée, réparer avec `sdig refresh`. La base opencode est lue en **lecture seule stricte** (`readonly` + vérification de lisibilité du schéma SQLite, aucune copie temporaire `db`/`-wal`/`-shm`) : un opencode concurrent peut réussir en RO ou échouer proprement, jamais un demi-état ; une source absente/illisible donne une erreur explicite (chemin, code, action) sans conseil de suppression.

**Lecture bornée en mémoire (06/10/2026)** : `sdig read` rend les événements EN FLUX — un à la fois, par itérateur SQLite paresseux — sans matérialiser la session ; la transaction de lecture reste ouverte pendant toute la sortie (un pipe lent retarde le checkpoint WAL, coût documenté) et la sortie terminale/JSON reste **identique octet pour octet** au rendu tableau historique. La mémoire est bornée par la fenêtre et par un événement rendu, pas par la taille de la session.

## Tri chronologique de la recherche (v0.8, 02/10/2026)

`--sort relevance|oldest|newest` sur la **commande de recherche uniquement** ; **option omise = `relevance`, strictement inchangé** (BM25, `score` numérique, regroupement par session). `oldest`/`newest` sélectionnent l'**ensemble** des matches filtrés (mêmes filtres `--repo --session --source --after --before --model --role --agent`) puis les ordonnent par `(ts, id BINARY)` **avant** `--limit` — jamais un top-k BM25 réutilisé. `ts = 0` est valide ; à `ts` égal, l'id canonique qualifié (`pi:<sessionId>:<id>`) départage en ordre binaire. **`--limit` tronque** : ce n'est pas une exhaustivité ni un curseur.

En `oldest`/`newest`, la **requête positionnelle est optionnelle** (mode exploration) : le sous-ensemble canonique est `role ∈ {user, assistant}` ∩ `--role` éventuel — une ligne `title` n'est **jamais** incluse sans mots-clés, et les événements à texte vide ou commandes seules le sont. Une requête **fournie** vide/en espaces/stopwords suit la normalisation existante (`no_terms`), sans bascule silencieuse. La métadonnée de modèle absente n'est jamais inventée (`model: null` en JSON) ; un avertissement **conditionnel** part sur `stderr` (le `stdout` JSON reste un tableau pur). Le rendu humain est **plat** (ordre global, entrelacement des sessions préservé) ; `--ctx` n'ajoute que des voisins, jamais candidats ni clés JSON. `--raw` refuse les modes chronologiques (le mode de pertinence reste compatible) ; les sous-commandes (`ingest`/`read`/`status`/`mcp`…) refusent toute option `--sort`. Validation locale sur **fixtures synthétiques** uniquement ; la validation sur PC n'est pas revendiquée.

## Pertes documentées (corpus fusionné)

- **Branches pi aplaties** : l'arbre `parentId` est déroulé par ordre temporel — une exploration abandonnée apparaît mêlée à la branche principale.
- **`context_edit` non appliqué** : l'archive garde le message original — l'append-only est physique, pas sémantique.
- **Parts `thinking` ignorées** : hors `text`, hors index (réversible par rebuild depuis la source).
- **Orphelines hors scan `--raw`** : preuves non référencées par un événement (exécution directe hors agent), lisibles par `sdig raw pi:<sessionId>:<id>` explicite et signalées à l'ingestion.
- **Lignes finales non terminées** (session pi vivante) : différées à la passe suivante — jamais acquittées partiellement.

> **Repère** : les sections « MCP — lot M1a », « MCP — lot M1b » et « MCP — accès données » ci-dessous sont **historiques** (états datés). L'état d'implémentation locale **actuel** (handlers `search`/`read`/`status` + commande `sdig mcp`) est décrit dans « MCP — lot M4 livré » plus bas ; leurs mentions « read non livré » ne reflètent plus l'état courant.

## MCP — lot M1a livré (contrats seuls, 01/10/2026)

**Périmètre strict** : ce lot ne livre ni serveur, ni transport monté, ni handler
`search`/`read`/`status` exécutable, ni fragmentation, ni validation de curseur, ni
ingestion, ni `raw`, ni autostart. Le jalon M1 (« transport et contrat commun »)
**reste incomplet**.

- **SDK officiel épinglé** : `@modelcontextprotocol/sdk` `1.31.0` (version publiée
  sur le registre npm officiel le 2026-09-28). Validation directe : `zod`
  `3.25.76`, exact. Versions exactes dans `package.json`/`package-lock.json`
  (installation locale seulement). API recoupée sur les déclarations du paquet
  officiel installé (`server/mcp.d.ts`, `zod-compat.d.ts`,
  `zod-json-schema-compat.js`, `inMemory.d.ts`, `client/index.d.ts`). Context7
  était **indisponible** les 01/10/2026 (échec de connexion) : fallback assumé sur
  npm + paquet installé ; à revérifier si Context7 redevient joignable.
- **Contrats** (`src/mcp/`) : catalogue fermé `sdig_search`/`sdig_read`/`sdig_status`
  (aucun `sdig_raw`) ; entrées Zod strictes (propriétés inconnues refusées,
  `cursor` refusé sur search/status, `cursor` mêlé à une nouvelle requête read
  refusé) ; bornes numériques entières sûres, epoch borné ; plafonds valides
  ramenés avec `adaptations` explicites ; `ctx=0` admis, pages nulles refusées ;
  source inconnue acceptée (zéro hit attendu) ; erreurs applicatives à **messages
  figés par code** (le `message` libre d'une exception n'est jamais sérialisé, et
  le `code` est revérifié contre la liste fermée — un code muté retombe sur
  `internal`).
- **Sortie search** décrit le contrat MCP (pas une copie du CLI) : hits typés
  `message`/`title`, référence read obligatoire (un titre référence la **seule**
  session, sans faux message), marqueur d'extrait, **voisins séparés** et
  référencés au hit éclairé, groupement par session, `topK` explicite, `count`
  réel des hits rendus et `total` inconnu à `null`. `nextCursor` est
  structurellement refusé (racine et `truncated`) sans bloquer les champs additifs.
  Champs de fidélité pi inchangés (limites exactes du format commun).
- **Sortie read** : fragments avec `offset`/`end`/`complete` **obligatoires** au
  contrat (unités fixées : **points de code Unicode**, `end` exclu, encodage UTF-8
  déclaré ; limite 20 000 points de code), `adaptations`, `freshness` **présente
  dans chaque réponse** (`indexMtime` nombre fini fractionnaire, `corpusVersion` =
  version de schéma entière positive, `null` si inconnu — jamais inventé),
  `truncated.nextCursor` réservé à read. L'implémentation de la
  pagination/fragmentation est **M3**. Le curseur n'est qu'une **entrée opaque**
  bornée : sa validation authentifiée (liaison outil/requête/génération) est **M3**
  et n'est pas livrée ici.
- **Status par source** : disponibilité, ingestion, watermark et compteurs
  `{sessions, events}` par source **nullable** (inconnu = `null`, jamais estimé).
- **Bornes temporelles search** : parité avec le CLI existant
  (`parseDateBound`), **sans** promesse de validation calendaire stricte ; `at`
  vide côté read donne `invalid_anchor` ; la validation d'ancre dans le contexte
  d'une session est M3.
- **Budget** : mesure UTF-8 d'enveloppe seulement (524 288 octets), aucune
  fragmentation implémentée.
- **Tests** : `test/mcp-contracts.test.js` (catalogue, compatibilité SDK avec
  `McpServer`/`Client` réel via `InMemoryTransport` — stubs de handler locaux au
  test, validation, descriptions, refus de `nextCursor`, confidentialité).

**Obligation notée pour M1b** : les erreurs de protocole du SDK peuvent recopier
les clés inconnues d'une entrée ; leur sanitisation doit être traitée en M1b — le
seul Zod strict ne suffit pas à garantir l'absence d'écho. **Traité en M1b** :
`tools/call` passe par une couche de validation propre (SDK bas niveau), et le
résultat d'erreur ne porte pas de `structuredContent`.

Détails de conception : [design add-mcp-server](openspec/changes/add-mcp-server/design.md)
(D2/D3/D7/D8/D10) ; état d'avancement : [tasks](openspec/changes/add-mcp-server/tasks.md).

## MCP — lot M1b livré (transport HTTP, garde-fous, admission ; 01/10/2026)

**Périmètre** : fabrique serveur Streamable HTTP officielle, réellement
fonctionnelle, avec **handlers métier injectés et requis** (exactement
`sdig_search`, `sdig_read`, `sdig_status` — aucun repli factice). Toujours **aucune
commande `sdig mcp`**, **aucun bin autonome lancé sur corpus**, **aucun accès
SQLite/corpus** : M1 reste partiel et le jalon PC n'est pas coché.

- **API dev** : `createMcpServer({ handlers, token?, logger?, dispose? })` = écoute
exclusive `127.0.0.1:18767` (toute autre adresse/port est refusée).
`createMcpTestServer(...)` = primitive de test uniquement, port OS éphémère sur
`127.0.0.1`. Chaque handler reçoit `(value, adaptations)` déjà validés/normalisés.
- **Transport** : Streamable HTTP **stateless** (un serveur et un transport neufs
par requête, réponse JSON), **route fixe `/mcp`** (toute autre route → 404), POST
uniquement (GET/DELETE → 405, pas de flux SSE), `initialize` / `tools/list` /
`tools/call` / reconnexion avec le `Client` officiel. Catalogue fermé ; aucune
resource, prompt ni `sdig_raw`. Les helpers JSON Schema sont les sous-chemins
**publiés** du paquet épinglé (`server/zod-compat.js`,
`server/zod-json-schema-compat.js`).
- **Anti-fuite SDK** : entête `mcp-protocol-version` prévalidée contre
`SUPPORTED_PROTOCOL_VERSIONS` **avant** le transport (le SDK recopiait la valeur) ;
paramètres connus malformés (initialize/tools/call/tools/list) → `-32602` générique ;
identifiant JSON-RPC borné (entier sûr ≥ 0 ou chaîne technique ASCII ≤ 128,
`null`/fractionnaire/objet/hors-jeu refusés, `id: null` alors) ; **toute réponse
d'erreur du SDK est sanitizée** (code + message d'une liste fermée, `data` supprimé),
les succès étant inchangés. La validation d'entrée M1a (`invalid_params` applicatif)
s'exécute avant le handler ; le message Zod du SDK n'est jamais emprunté pour
`tools/call` (`Server` bas niveau).
- **Garde-fous** : `Host` en syntaxe **brute** — `127.0.0.1`, `localhost` ou
`[::1]` avec le **port d'écoute courant sans zéro de tête** ; `Origin` en syntaxe
**brute** (jamais une normalisation d'URL) — absent permis, sinon HTTP(S) loopback
sans chemin/slash racine/credentials/requête/fragment, origines multiples et
formes trompeuses (`127.1`, `%2e`, `\`, `0x…`, port 0/65536) refusées ;
**jeton Bearer optionnel** (config validée au constructeur : absent/null =
désactivé, `''`/espaces/type non-chaîne/trop long refusés ; jamais converti)
exigé sur chaque requête ; la comparaison de **digests de taille fixe**
(SHA-256) se fait en temps constant (`timingSafeEqual`), **sans prétendre** que le
parsing, le hachage ou le serveur s'exécutent en temps constant, jamais journalisé
ni renvoyé ; corps borné à 256 Kio avant analyse JSON,
en-têtes limités à 16 Kio. Erreurs JSON-RPC bornées sans écho.
- **Admission & arrêt** : mono-travail **server-global** (pas par requête) —
`busy` si le créneau est occupé **au moment où le gestionnaire admet l'appel**,
sans file applicative ; **aucune réactivité immédiate garantie** pendant un calcul
synchrone (une requête reçue pendant un calcul peut n'être admise qu'après sa fin) ;
l'admission est bloquée dès que
la fermeture est entamée (avant et après lecture du corps) ; le créneau reste tenu
jusqu'à la fin du handler malgré une déconnexion ; `close()` refuse les nouveaux
travaux, **annule les corps incomplets**, attend le handler actif **et la réponse en
cours** (sans détruire de réponse active), puis appelle `dispose` (erreur de
`dispose` propagée comme échec, `close` idempotent). `close` avant `start` est
cohérent ; `start` après `close` est refusé. Aucun signal global, aucun travail
détaché, aucun autostart, aucun appel réseau sortant.
- **Sortie** : validée par les schémas M1a ; non conforme → `internal` borné ;
budget d'enveloppe JSON-RPC 524 288 octets, `content` **toujours présent**
(`[]` si le texte dupliqué est retiré), sinon `internal`.
- **Tests** : `node --test test/mcp-server.test.js` (27 tests, stubs synthétiques,
port OS éphémère sur `127.0.0.1` uniquement, `Client` Streamable HTTP réel, requêtes
HTTP brutes pour les en-têtes dupliqués/volumineux). La production n'est **pas**
liée dans les tests (aucun port 18767 ouvert) ; la primitive éphémère est le test TCP réel.

**Limites restantes** : handlers métier réels = lots suivants ; pas de lancement
utilisateur (`sdig mcp`), pas de timeout applicatif garanti. Context7 était
indisponible (fallback : registre npm + déclarations et code du paquet
`@modelcontextprotocol/sdk@1.31.0` installé).

## MCP — accès données lecture seule (lot data M1, 01/10/2026)

**Périmètre** : `src/mcp/data.js` ouvre la vue publiée en lecture seule et exécute
un callback SYNCHRONE dans un **seul snapshot**, avec contrôle de fraîcheur par
source. Toujours **aucun handler `sdig_search`/`sdig_read`/`sdig_status`**, aucune
commande `sdig mcp`, aucun serveur sur corpus réel, aucune ingestion/réparation,
aucun curseur ni fragmentation (M3 non livré) ; **M1 complet non atteint** (handlers métier et lancement à venir) et **aucune validation PC** du jalon.

- **API** : `openReadSnapshot({ root, sources }, callback)` → `{ data, freshness,
  availability }`. `root` et `sources` viennent de la configuration du propriétaire
  (jamais d'un chemin fourni par l'appelant). La vue est ouverte
  `{ readonly: true, fileMustExist: true }` + `PRAGMA query_only`, sans créer la
  base ni le corpus. Le callback reçoit une **façade lecture seule** (pas
  d'`exec`/`pragma`/`attach`, statements `reader` seulement) et est **du code
  interne de confiance**, pas une entrée d'agent ni un bac à sable.
- **Fraîcheur** : la décision vient de `checkFresh` (logique commune `src/view.js`,
  pas de duplication). `freshness = { sources, indexMtime, corpusVersion }` :
  watermarks **publiés** par source (opencode `message`/`session`, pi `token` +
  nombre de fichiers suivis ou `null`), horodatage d'index (diagnostic) et version
  de schéma. Aucun chemin local, aucun nom de fichier suivi. `view_unavailable`
  avec raison fermée : `missing_view`, `invalid_schema`, `missing_state`,
  `stale_view`, `pi_divergence`, `changed_publication`. Une vue opencode en avance
  (COMMIT avant `state.json`) reste lisible ; une divergence de jeton pi refuse
  jusqu'à réconciliation CLI ; une source absente mais archivée ne bloque pas.
- **Cohérence** : UN état publié **capturé une seule fois** (stat avant/après lecture du contenu, JSON strict, `layoutVersion` numérique exacte) alimente `checkFresh` (option `state` additive) et les projections ; aucune seconde lecture disque ne peut intercaler une autre publication. L'identité de l'index est capturée **avant** l'ouverture puis vérifiée après l'établissement du snapshot et avant rendu. Sont refusés (`view_unavailable: changed_publication`) : republication d'état pendant la capture/callback, remplacement d'`index.db` à tout moment, COMMIT concurrent d'une autre connexion (`PRAGMA data_version` relu après le COMMIT — jamais pendant la transaction, isolation de snapshot).
- **Callback purement synchrone** : les formes `AsyncFunction`/`AsyncGeneratorFunction`/`GeneratorFunction` sont refusées **avant invocation** (`internal: async_callback`/`unsupported_callback`) ; un `Promise` renvoyé par un callback sync est refusé sans être attendu, et un rejet de **Promise native** est neutralisé par un `catch` vide (aucune prétention d'annulation, aucun `.then` arbitraire). Une exception non applicative devient `internal` bornée. Le callback est du code interne de confiance, **pas un bac à sable** : `PRAGMA`/lecture d'autres fichiers via la connexion reste de la responsabilité de ce code.
- **Aucune génération persistante ni curseur** : `data_version` n'est qu'une détection sur une connexion, l'horodatage d'index n'est pas une identité. Les cursors restent M3.
- **`availability`** : `stat` seul (aucun contenu), `opencode` attend un fichier et `pi` un répertoire ; type inversé → `false`, absence → `false`, erreur d'accès → `null` (inconnue). Config propriétaire explicite (`opencode`/`pi`, `{ path }`) ; noms inconnus ignorés et jamais renvoyés.
- **WAL — exception étroite autorisée (décision utilisateur du 01/10/2026)** : SQLite peut **créer puis laisser** ses annexes natives de coordination `index.db-wal` et `index.db-shm` pour la vue (mesures synthetic : `-shm` 32 768 o, `-wal` 0 o après `readonly.close`, SHA-256 de `index.db` identique). Cette conformité **limitée et explicite** n'autorise aucune écriture de **données** du corpus, de la vue ou de la base source ; aucune suppression/cleanup manuel sous concurrence ; `immutable=1` et l'ignorance d'un WAL vivant restent exclus ; un stockage incapable d'assurer cette coordination doit produire un refus borné (`view_unavailable`) plutôt qu'une autre écriture. Aucune extension à d'autres fichiers ni sources ; spec et producteurs CLI non modifiés.
- **Tests** : `node --test test/mcp-data.test.js` (35 tests, fixtures synthétiques sous tmp, aucun accès source réelle), dont type/accès `availability`, injections FS déterministes (état republié, index remplacé pendant l'établissement et pendant la capture finale), **concurrence MULTIPROCESSUS WAL entre deux SELECT du callback** (writer enfant `spawnSync` : snapshot isolé, puis refus `changed_publication` par `data_version` ; lecture suivante voit la publication, vue opencode en avance permise), refus async/generator, neutralisation de rejet natif, et mesure exacte des annexes WAL (autorisées par consentement utilisateur du 01/10/2026).
- **Sources de vérification** : Context7 (better-sqlite3) était **inaccessible** ; recoupement sur les docs officielles — SQLite WAL « Read-Only Databases » (https://www.sqlite.org/wal.html), `PRAGMA data_version` (https://www.sqlite.org/pragma.html#pragma_data_version, comparaison sur la même connexion), API better-sqlite3 (https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md, callbacks de transaction async non supportés). Aucune version ni dépendance présumée : les **mesures et tests locaux restent la provenance principale**.

## MCP — lot M4 livré (commande `sdig mcp`, 01/10/2026)

**Périmètre** : `src/mcp/app.js` monte **EXACTEMENT** les trois handlers réels
(`createSearchHandler`/`createReadHandler`/`createStatusHandler`) sur le serveur
Streamable HTTP de **production** (`createMcpServer`, `127.0.0.1:18767/mcp`).
Commande **manuelle** `sdig mcp [--home|--db|--pi-dir]` ; jeton **optionnel** via
l'environnement `SESSION_DIG_MCP_TOKEN` (jamais affiché) ; journaux techniques
stderr à **liste blanche fermée** ; arrêt **SIGINT/SIGTERM** propre (`server.close`
puis purge du cache de curseurs). **Aucun autostart, aucune supervision, aucune
installation, aucun second transport, aucun travail détaché, aucune réparation
implicite.** Le parser `mcp` est **dédié et fermé** : options inconnues et
positionnels refusés **sans écho** (un flag arbitraire peut transporter un secret).
Guide complet : [docs/mcp.md](docs/mcp.md).

- **Statut (correction)** : `rawFiles` = nombre **physique** de fichiers de preuve
  — **`null`** tant qu'aucun compteur physique fiable n'existe (le MCP ne scanne
  pas `raw/`) ; `rawReferences` = compteur **exact de la vue** (`rawrefs`), `null`
  si la table est indisponible.
- **Tests** : `test/mcp-app.test.js` (fabrique + journal sûr, E2E client officiel
  éphémère : search→read paginé→status, reconnexion, filtre source, archive SHA
  hors annexes WAL, arrêt/redémarrage, `stale_cursor`, SIGTERM enfant, CLI `--help`
  et arguments invalides sans écho). Les serveurs de test sont **éphémères** : le
  port **18767 n'est jamais lié** pendant les tests.
- **Non fait** : jalon **J-MCP**, archive
  privée, éval gelée (décision de clôture du principal ; lot B de scale-corpus
  restant : rebuild réel, mesures). La validation PC a eu lieu le 05/10/2026 :
  client MCP réel sur corpus réel, recollement par hash, intégrité vérifiée —
  [bilan](openspec/changes/scale-corpus/validation-pc-2026-10-05.md).

## Roadmap

**Prochain jalon, recentré à la demande explicite de l'utilisateur : usage solo local validé sur PC.**
1. Valider les prérequis d'intégrité/reprise et d'exclusion des écrivains avant usage sur corpus réel.
2. Tester ingestion et recherche CLI sur PC, puis un MCP minimal `search`/`read`/`status` : recherche top-k sans curseur, lecture complète par fragments, confidentialité dès le départ. Un seul travail actif, sans timeout applicatif garanti.
3. Optimiser selon les mesures ; raw MCP, pagination search, parallélisme et timeout strict restent des extensions possibles sur accord. Les bancs étendus ne bloquent pas le premier jalon ; aucun change n'est automatiquement déclaré terminé.

Détails : [jalon et validation PC](openspec/changes/scale-corpus/proposal.md), [tâches MCP](openspec/changes/add-mcp-server/tasks.md). Ce recentrage modifie les specs, pas le code déjà livré.

| Phase | Contenu | Statut |
|-------|---------|--------|
| v0 | adaptateur opencode + corpus + retriever FTS5 + CLI `sdig` | ✅ fait |
| v0.1 | **retrouver la décision et ses preuves** : `read`/`--ctx` (contexte), `raw` (preuve), `--raw` (stderr) | ✅ fait |
| v0.2 | évaluation sur recherches réelles (`npm run eval`) — 26 questions, **26/26 top1** après 3 améliorations motivées par l'éval (titres indexés, stopwords, OR pondéré) | ✅ fait |
| v0.3 | **jamais de coupure silencieuse** (analyse du 1er passage du jeu naturel, 19/09) : marqueur de troncation (compteurs + chemin), `--full`/`--chars N`, `--json` intégral + 2 questions brûlées en régression | ✅ fait |
| v0.4 | **évaluation traçable** (20/09) : audit déterministe des accès (`scripts/audit-toolcalls.mjs`, motifs épinglés, « à examiner », statut « audit incomplet ») + grille de notation de l'éval naturelle | ✅ fait |
| v0.5 | **ancrage temporel** (20/09) : `sdig read --at <ancre>` masque les messages postérieurs à l'instant demandé — ancre affichée, marqueur explicite, `--json` (ancre + compte) | ✅ fait |
| v0.6 | **scaling** : layout v2 shardé par condensat, vue reconstruisable en chemin de lecture, publication transactionnelle de la vue et reprise des shards, migration sans source | implémentée, passe corrective en cours ([progress](openspec/changes/scale-corpus/progress.md)) |
| v0.7 | **corpus fusionné** : adaptateur pi (JSONL append-only), état multi-source + jetons de fraîcheur par source, `--source`/`--pi-dir`, filtre de provenance (`--source`, `--json`), partIds pi validés, orphelines signalées | ✅ fait |
| v0.8 | **tri chronologique CLI** (02/10) : `--sort relevance|oldest|newest` (défaut `relevance` inchangé), sélection globale `(ts, id BINARY)` avant `--limit`, mode sans mots-clés user/assistant, JSON tableau + avertissement modèle sur `stderr` | ✅ implémenté (fixtures) ; PC non revendiqué |
| v1 | MCP local lecture seule : `search` top-k, `read` complet par fragments, `status` — périmètre solo ci-dessus | **implémenté localement (fixtures)** ; validation PC et jalon J-MCP à faire |
| v2 | embeddings + fusion RRF — **activés seulement si l'évaluation montre un manque lexical** | conditionné |
| v3 | `sstats` : comparaison de modèles (coût, tokens ; exitCode = signal brut, pas une note) | à venir |

Corpus local uniquement — jamais publié, jamais transmis (fixtures synthétiques pour les tests). **Les sessions pi peuvent contenir du matériel sensible** (chemins Termux, jetons, extraits de configuration) : le corpus reste sur la machine, mais ce que le CLI retourne peut être transmis au fournisseur du modèle appelant — mêmes précautions que pour le serveur MCP prévu en v1.
