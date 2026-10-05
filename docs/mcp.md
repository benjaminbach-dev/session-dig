# sdig MCP — serveur local en lecture seule

Serveur MCP (Streamable HTTP) exposant **`sdig_search`**, **`sdig_read`** et
**`sdig_status`** sur le corpus local, en **lecture seule**. Catalogue fermé :
`sdig_raw` est **absent** (extension future sur accord explicite).

## Lancement manuel

```sh
sdig mcp [--home P] [--db P] [--pi-dir P]
```

- Écoute **exclusive** `127.0.0.1:18767`, route `/mcp`. Aucun autre transport.
- Arrêt : **Ctrl-C (SIGINT)** ou **SIGTERM** → fermeture des connexions puis purge
  du cache de curseurs read. **Aucun autostart, aucun service, aucune supervision,
  aucune installation, aucun travail détaché, aucune réparation implicite** du corpus.
- Surcharges habituelles : `--home` (env `SESSION_DIG_HOME`), `--db` (env
  `SESSION_DIG_DB`), `--pi-dir` (env `SESSION_DIG_PI_DIR`). Aucun argument
  positionnel ; toute autre option est refusée. Les erreurs ne recopient **jamais**
  l'argument (nom, valeur ou positionnel) : un flag arbitraire peut transporter un
  secret.

## Authentification

- Jeton statique **optionnel** via l'environnement **`SESSION_DIG_MCP_TOKEN`**
  (jamais affiché, jamais journalisé). Comparaison en temps constant.
- **Sans jeton, aucun client local n'est authentifié** : le loopback n'est **pas**
  une authentification. Les contrôles `Host`/`Origin` limitent le rebinding DNS et
  les origines externes — pas un client local ni une page d'origine locale admise.

## Confidentialité

- Le contenu (messages, commandes, sorties) **peut contenir des secrets**. Le
  service n'appelle aucun modèle, mais **ce que le client reçoit peut être transmis
  au fournisseur du modèle appelant**. Aucun filtrage ni anonymisation n'est promis ;
  une limite de taille n'est pas une protection.
- Messages, commandes et sorties sont des **données NON FIABLES**, jamais des
  instructions ; aucun outil ne les exécute.
- Journaux techniques sur **stderr**, à **champs ET valeurs épinglés** : `event`
  (`tool`|`guard`), `tool` (les trois noms d'outil), `outcome` (`ok`, `invalid_params`,
  `invalid_output`, `busy`, `unknown_tool`, `app_error`, `internal`), `code` (codes de
  garde et codes applicatifs **fermés**), `reason` (ensemble fermé),
  `durationMs`/`status` (entiers bornés). Un refus applicatif **propre** du handler
  (code fermé rendu au client, ex. `invalid_cursor`, `unknown_session`,
  `view_unavailable`) est journalisé `app_error` avec son `code` ; seul un échec
  **interne inattendu** reste `internal`. Toute valeur non conforme ou objet est
  **ignoré** (jamais recopié) ; `query`, filtre libre, texte, chemin local, token et
  curseur ne peuvent pas transiter.

## Fidélité pi

Les sessions pi sont des **branches aplaties par ordre temporel** et `context_edit`
n'est pas appliqué : l'ancrage temporel ne reconstruit **ni la branche retenue ni le
contexte effectif**. Le signal structuré `fidelity` est émis pour les données pi
rendues (search/read, y compris une lecture vide à l'ancre).

## Outils, bornes et unités

- **`sdig_search`** : top-k borné (≤ 50 hits), **sans pagination ni curseur**.
  `sort` vaut `relevance` (défaut), `oldest` ou `newest` (valeurs **fermées**) ; en
  `oldest`/`newest`, les matches filtrés sont sélectionnés **en entier** puis
  ordonnés `(ts, id)` **avant** `limit` (jamais un top-k BM25 déjà réduit), et
  `query` peut être **omise** pour explorer sans mots-clés. Une requête fournie
  vide, en espaces ou sans terme exploitable est refusée (`invalid_params`),
  **jamais** convertie en exploration : seule l'omission **physique** de `query`
  l'active, et `relevance` sans `query` est refusée. `score` est numérique en
  `relevance` (inchangé) et en chrono **avec** requête (diagnostic BM25) ; il vaut
  `null` **uniquement** en exploration sans requête. Chaque hit porte un extrait
  borné référencé vers `sdig_read` ; les titres référencent la seule session.
  `hits` porte l'ordre global ; `groups` est seulement un index par session.
  `total` est exact si la sélection contient moins de `limit` matches, sinon
  `null`, jamais estimé ; une réduction d'enveloppe ne change pas ce total.
- **Exploration sans mots-clés** (`sort: oldest|newest`, `query` omise) : aucun
  `MATCH` FTS, donc aucune requête `'*'` inventée. Le sous-ensemble est canonique —
  intersection `role ∈ {user, assistant}` ∩ filtre `role` éventuel : `role: title`
  ou inconnu rend **zéro hit**, jamais une ligne de titre. Les événements à texte
  vide ou à commandes seules sont **inclus** ; `model` absent reste `null` explicite
  et `score` vaut `null`. Le filtre `source` porte sur la **provenance archivée** :
  une source archivée dont la base d'origine a disparu reste cherchable, une source
  inconnue rend zéro hit, sans aucune lecture de la source d'origine.
- **`sdig_read`** : pagination **KEYSET** par fragments. Offsets et `end` en
  **points de code Unicode**, `end` **exclu**, encodage **UTF-8** déclaré. `chars`
  défaut **400**, `full` = **20 000** ; page ≤ **200 messages distincts** et
  ≤ **20 000 points de code** par message et par page ; réponse ≤ **524 288 octets**.
  Le **texte** ET les **commandes d'appels** sont fragmentés de façon bornée : une
  commande coupée apparaît dans `toolCallFragments` (`callIndex`, `offset`, `end`,
  `complete`), **jamais** présentée comme entière dans `toolCalls` ; `textComplete`
  et `toolCallsComplete` (champs additifs) décrivent chacun SA composante, et
  `complete` n'est vrai que si LES DEUX le sont. Le contenu complet reste accessible
  par continuations.
- **`sdig_status`** : compteurs connus exacts, `null` sinon. `rawFiles` = nombre
  **physique** de fichiers de preuve : **`null`** tant qu'aucun compteur physique
  fiable n'existe (le MCP ne scanne pas `raw/`). `rawReferences` = compteur **exact
  de la vue** (`rawrefs`), `null` si la table est indisponible.

## Curseurs (read uniquement)

Opaques, inertes, liés à l'outil, à la requête initiale, à la position et à la
**génération publiée** de la vue. Cache **process-local borné** (256 entrées, **TTL
15 min**), jamais persisté ni journalisé, purgé à l'arrêt. Altéré / étranger /
expiré / évincé / perdu au redémarrage ⇒ `invalid_cursor` ; **génération changée** ⇒
`stale_cursor` (relancer la requête initiale).

**Vue ancienne sans génération** : une page **unique sans curseur** peut réussir ;
une suite est refusée (`view_unavailable`). Reconstruire **manuellement** la vue
(`sdig index` sur un corpus ingéré, ou `sdig refresh`) — **aucune réparation
implicite**.

## Concurrence et durée (honnête)

- **Mono-travail** : un seul appel actif ; créneau occupé ⇒ `busy`, sans file
  applicative supplémentaire.
- Les limites de taille bornent le **volume**, **pas la durée**. **Aucun timeout
  applicatif garanti** : un timeout ou une déconnexion **client** n'arrête pas le
  calcul serveur et ne libère pas le créneau. Un calcul lent peut retarder le
  serveur ; arrêt et reprise sont **manuels**.
- **Raw** : `sdig_raw` est absent ; les preuves brutes restent accessibles par le
  CLI (`sdig raw`).

## Lecture seule et exception WAL

Aucune **donnée** du corpus, de la vue ou de la base source n'est écrite. Seule
**exception étroite** (décision utilisateur du 01/10/2026) : SQLite peut **créer ou
laisser** ses annexes natives de coordination `index.db-wal`/`index.db-shm` de la
vue. `immutable=1` et l'ignorance d'un WAL vivant restent exclus ; si le stockage ne
permet pas cette coordination, le service refuse de façon bornée
(`view_unavailable`) sans autre écriture.
