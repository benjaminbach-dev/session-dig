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
  (`tool`|`guard`), `tool` (les trois noms d'outil), `outcome` et `code` (énumérés),
  `reason` (ensemble fermé), `durationMs`/`status` (entiers bornés). Toute valeur
  non conforme ou objet est **ignoré** (jamais recopié) ; `query`, filtre libre,
  texte, chemin local, token et curseur ne peuvent pas transiter.

## Fidélité pi

Les sessions pi sont des **branches aplaties par ordre temporel** et `context_edit`
n'est pas appliqué : l'ancrage temporel ne reconstruit **ni la branche retenue ni le
contexte effectif**. Le signal structuré `fidelity` est émis pour les données pi
rendues (search/read, y compris une lecture vide à l'ancre).

## Outils, bornes et unités

- **`sdig_search`** : top-k borné (≤ 50 hits), **sans pagination ni curseur**. Chaque
  hit porte un extrait référencé vers `sdig_read` ; les titres référencent la seule
  session. `total` inconnu = `null`, jamais estimé.
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
