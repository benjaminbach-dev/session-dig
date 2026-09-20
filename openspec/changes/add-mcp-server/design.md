# Design — add-mcp-server

Décisions arrêtées avant implémentation (SDD). Les valeurs numériques sont des **bornes de
conception**, à vérifier et ajuster à l'implémentation avec mesure (comme les cibles de performance de
`search`) ; les règles de confidentialité et de fermeture, elles, ne sont pas négociables.

## D1 — Transport : Streamable HTTP sur loopback

- **Streamable HTTP** (spec MCP 2025-03-26 et suivantes), pas stdio : le patron `agora-scout` est déjà
  intégré dans Agora via ce transport, et un service supervisé par le manifeste Termux survit aux
  redémarrages du client MCP sans que le client ait à relancer un processus.
- **`127.0.0.1:18767`** — loopback exclusif. Ports voisins occupés : `18765` = proxy ccp,
  `18766` = agora-scout. On refuse `0.0.0.0` et toute interface externe, y compris en configuration :
  le service n'a aucune raison d'être joint depuis le réseau, et l'erreur de configuration la plus
  coûteuse possible ici est justement « exposé par accident ».
- **Pas d'authentification par défaut** (bind loopback), **token statique optionnel** activable par
  configuration — même décision que `agora-scout` (14/09), assumée : la surface d'attaque reste le
  loopback de la machine, et un token mal géré donnerait une fausse impression de sécurité. Un mode
  `stdio` pourra être ajouté plus tard sans casser les outils ; hors périmètre ici.
- **Aucun egress** : le service n'appelle ni fournisseur de modèle, ni API, ni le proxy. Il lit le
  corpus local et répond. C'est la différence de nature avec `agora-scout` (qui, lui, appelle un
  modèle) : ici, zéro coût et zéro fuite par le service lui-même.
- SDK : MCP TypeScript officiel (`@modelcontextprotocol/sdk`). **Version épinglée à l'implémentation**
  après vérification (le paquet est passé en ligne v2 — `@modelcontextprotocol/server`/`client` — et la
  version publiée évolue) ; la spec n'écrit donc pas de numéro qu'elle n'a pas vérifié.

## D2 — Catalogue fermé de 4 outils

| Outil | Paramètres (bornés) | Réponse |
|---|---|---|
| `sdig_search` | `query` (obligatoire, ≤ 512 car.), `repo`, `session`, `after`, `before`, `model`, `role`, `agent`, `limit` (défaut 10, **max 50**), `ctx` (0–5) | hits groupés par session + `truncated` + `freshness` |
| `sdig_read` | `session` (obligatoire), `around`, `ctx` (0–**50**), `tail` (≤ **200**), `at` (ancre), `chars` (≤ **20 000**), `full` (bool) | vue bornée + `anchor` + `maskedCount` + `visible`/`total` + `truncated` |
| `sdig_raw` | `partId`, `head` (lignes, ≤ **2 000**), `maxBytes` (≤ **64 Ko**) | contenu de la preuve — **désactivé par défaut** (D5) |
| `sdig_status` | — | compteurs, watermark, état de l'index (**sans chemin local**) |

Refus par construction : aucune sous-commande d'écriture (`ingest`, `refresh`, `index`), aucun shell,
aucun accès fichier arbitraire, aucun outil de type `resource`/`prompt` exposant le système de
fichiers, aucune lecture des fichiers du jeu d'évaluation. Un outil non listé n'existe pas.

## D3 — Bornes et « jamais de coupure silencieuse »

Le principe du change `add-remedy-truncation` s'applique tel quel côté MCP : un agent qui reçoit une
sortie coupée sans le savoir conclut à tort que l'archive ne contient pas la suite. Donc :

- tout résultat borné porte un objet `truncated` : `{ hits?, messages?, chars?, bytes? }` avec les
  compteurs **exacts** (retenus / totaux), l'action qui élargit (`limit`, `chars`, `head`, `full`) et
  le **curseur de continuation** `nextCursor` (D8 : signaler ne suffit pas si la suite est
  inaccessible) ;
- **plafonds durs** (indépassables par les paramètres) : 50 hits, 200 messages, 20 000 caractères par
  message, 64 Ko par preuve brute, et un **budget de réponse** de 512 Ko par appel — au-delà, le
  service tronque et le dit, il ne coupe pas en silence ;
- `full` lève la limite d'affichage par message **dans la limite** du plafond dur (et le dit quand il
  bute dessus) ; le budget total reste la borne ultime.

## D4 — Ancrage temporel exposé, même sémantique que le CLI

`sdig_read` accepte `at` et applique **exactement** les règles du change `update-read-at` : horodatage
UTC, validité calendaire stricte, ancre vide refusée, inclusion de l'instant exact, masquage **avant**
fenêtrage, `maskedCount` + `anchor` dans la réponse, aucune détection de mutation. La logique est
appelée, pas réimplémentée : une divergence entre CLI et MCP serait un piège pour les agents et un
défaut de conception.

## D5 — `raw` désactivé par défaut

Les sorties d'outils brutes sont **non triées** : elles contiennent du stderr, des dumps de
configuration, parfois des secrets que l'utilisateur a affichés dans une session. En CLI, l'accès est
explicite et l'opérateur est devant son écran ; exposé comme **outil d'agent**, le même contenu part
directement dans le contexte d'un modèle, potentiellement chez un fournisseur distant.

- `sdig_raw` n'est **pas** enregistré par défaut ; il s'active par configuration
  (`expose_raw: true`), et l'activation est journalisée.
- Quand il est actif, la réponse porte un avertissement explicite (`unvetted: true`) et reste bornée
  (D3). L'aide de l'outil dit ce qu'il expose.
- Le CLI garde `sdig raw` sans restriction : c'est l'humain qui lit.

## D6 — Concurrence, délais, erreurs

- **Concurrence bornée** : 2 requêtes simultanées par défaut (configurable) ; au-delà, réponse
  `busy` explicite plutôt qu'une file sans borne — patron `agora-scout`, motivé ici par le fait que le
  corpus est un fichier SQLite local : saturer ne gagne rien, empiler des requêtes retarde seulement
  tout le monde.
- **Délai par appel** : 5 s par défaut (configurable). ⚠️ Les lectures du projet sont **synchrones**
  (fichiers + better-sqlite3) : un `setTimeout` ou un `Promise.race` **ne peut pas** interrompre le
  travail en cours. Le délai est donc rendu applicable par deux mécanismes combinés (D9) : travail
  exécuté dans une **unité interruptible** (worker thread dédié, terminable) et, en première ceinture,
  requêtes **bornées en travail** (LIMIT SQL, plafonds de lignes et d'octets). À l'expiration, le
  **créneau de concurrence est rendu immédiatement** et aucun travail orphelin n'est laissé tourner.
  Correction assumée de la première version de cette spec : « toujours retourner du partiel » était
  trop contraignant — un partiel vide est une information **fausse**.
- **Ouvertures en lecture seule** (`mode=ro`, index ouvert en readonly) : le service ne peut pas
  bloquer le CLI ni corrompre l'index ; il ne prend jamais le verrou d'écriture.
- **Erreurs structurées** : `{ error: { code, message } }` avec des codes stables (`unknown_session`,
  `invalid_anchor`, `unknown_part`, `invalid_params`, `busy`, `timeout`, `internal`) — jamais un succès
  vide ambigu, jamais un message d'erreur qui recopie un contenu d'archive.

## D7 — Fraîcheur, déterminisme, schéma

- Chaque réponse porte `freshness: { watermarkMessage, watermarkSession, indexMtime, corpusVersion }`
  (le schéma de corpus est versionné depuis la v0). Un appelant peut ainsi détecter que le corpus a
  bougé entre deux appels — nécessaire dès qu'un agent enchaîne recherche et lecture.
- **Déterminisme** : à corpus et paramètres identiques, la réponse est identique (pas d'horloge dans le
  contenu, pas d'échantillonnage).
- **Compatibilité** : ajouter un champ est additif (OK) ; retirer ou renommer un champ, ou changer une
  borne à la baisse, est un changement de spec. Les champs indisponibles sont **absents ou `null`**,
  jamais inventés (règle héritée d'`agora-scout`).

## D8 — Continuation : rien n'est inaccessible

Signaler une coupure ne sert à rien si la suite est hors de portée : avec les plafonds de D3, un message
de 30 000 caractères resterait incomplet même avec `full`, une liste de plus de 50 hits serait coupée,
et une preuve de plus de 64 Ko tronquée. C'est le défaut que `add-remedy-truncation` a corrigé en CLI —
le MCP ne doit pas le réintroduire.

- Chaque réponse tronquée porte `truncated.nextCursor` : un **curseur opaque** que l'appelant renvoie
  tel quel (`cursor`), pour obtenir la suite **du même contenu** — filtres, ancre, fenêtre et ordre
  conservés (le curseur les transporte, l'appelant n'a rien à reconstruire).
- **Aucun plafond caché** : en suivant les curseurs jusqu'à épuisement, on obtient l'intégralité
  (message entier, liste entière, preuve entière). Le nombre d'appels est borné par la taille du
  contenu divisée par le plafond par appel — c'est fini et documenté.
- **Recollement exact** exigé : segments successifs sans doublon, sans trou, sans caractère perdu
  (testable par concaténation).
- **Curseur lié à l'état du corpus** : il transporte l'empreinte de fraîcheur (D7). Si le corpus a
  bougé entre deux segments, réponse `stale_cursor` avec invitation à relancer la requête — servir une
  suite incohérente serait pire que refuser. Curseur altéré ou étranger (`invalid_cursor`).
- Le curseur est **inerte** et opaque : il ne modifie rien et n'expose pas son contenu à l'appelant.

## D9 — Délai réellement applicable

Le délai de D6 n'est crédible que si quelque chose peut **arrêter** le travail. Le projet lit des
fichiers et du SQLite de façon synchrone : une promesse en course ne coupe rien.

- **Ceinture 1 — borner le travail** : chaque requête est bornée en amont (`LIMIT` SQL, plafonds de
  lignes/octets, pagination par curseur). À plafonds respectés, le temps de réponse est de l'ordre de la
  mesure du 15/09 (requête type < 11 ms à 5 000 messages) : le délai n'est atteint que dans un cas
  anormal (disque lent, corpus anormalement gros).
- **Ceinture 2 — unité interruptible** : le travail d'un appel est exécuté dans un **worker thread
  dédié** (ou un processus), que le service peut **terminer** à l'expiration. C'est ce qui rend la
  libération du créneau réelle : pas de travail orphelin qui continue de consommer après un `timeout`.
- **Résultat** : partiel + `stop_reason: timeout` **seulement si** des éléments exploitables existent
  déjà (typiquement : les hits obtenus avant la coupure) ; sinon erreur `timeout`. Jamais de partiel
  vide, jamais de succès muet.
- Le mécanisme retenu est documenté dans le README (l'exigence de spec le demande) et l'implémentation
  ne le remplace pas par un minuteur décoratif.

## D10 — Journaux : liste autorisée, pas « métadonnées »

« Métadonnées = paramètres » est trop large : `query` peut être une citation privée, un nom de fichier
ou un secret recherché ; l'ancre d'un message ou un identifiant de preuve sont des identifiants, mais
un texte libre ne l'est pas. La règle devient une **liste autorisée** :

- autorisés : nom d'outil, paramètres **numériques** (limit, ctx, tail, chars, head, offsets), durée,
  compteurs (retenus/totaux), code d'erreur, et identifiants techniques opaques (session, preuve) —
  utiles au support et non porteurs de contenu ;
- interdits par défaut : `query`, tout texte libre, tout contenu de message ou de sortie d'outil ;
- mode debug `log_content: true` : jamais par défaut, activation tracée dans le journal.

## D11 — Confinement HTTP, identifiants de preuve, contenu non fiable

Trois durcissements demandés avant l'implémentation :

- **Loopback ≠ authentification** : validation stricte de l'en-tête `Host` (formes loopback
  attendues uniquement) et refus de tout `Origin` non loopback — protection contre le rebinding DNS et
  les appels depuis une page web locale. Le token statique optionnel devient alors une **vraie**
  barrière quand il est configuré (exigé sur chaque requête, comparaison en temps constant) ; sans
  token, la documentation dit que la seule barrière est le loopback.
- **`partId` = entrée non fiable** : format strict, existence vérifiée dans le corpus, chemin **dérivé**
  de l'identifiant (jamais fourni par l'appelant), résolution confinée au répertoire des sorties
  brutes avec refus des liens symboliques et des fichiers spéciaux (`realpath` + ouverture
  `O_NOFOLLOW`). Même logique que le confinement des chemins d'`agora-scout` (TOCTOU compris).
- **Contenu = données, jamais instructions** : les descriptions des outils MCP rappellent explicitement
  que messages, commandes et sorties d'outils peuvent contenir n'importe quel texte, y compris des
  consignes adressées au modèle, et qu'elles ne doivent être ni suivies ni exécutées. Le service, lui,
  n'exécute rien : la règle est portée par les descriptions (contrat visible par le modèle appelant) et
  par le fait qu'aucun outil ne prend de commande en entrée.

## D12 — Journaux et supervision

- Journaux = **liste autorisée** (D10) : nom d'outil, paramètres **numériques** (limites, fenêtres,
  offsets), identifiants techniques opaques (session, preuve), compteurs, durée, code d'erreur. Tout
  **texte libre** est exclu par défaut — en particulier `query` : une requête est du contenu (citation
  privée, nom de fichier, secret recherché) et n'a rien à faire dans un journal. Un mode debug
  (`log_content: true`, jamais par défaut, activation annoncée) peut les ajouter.
- Démarrage par le **manifeste Termux** (`agora_server_debian session-dig …`), logs
  `~/.agora/log/session-dig.log`, arrêt par `agora_stop` — la modification du manifeste est une
  **décision propriétaire** (comme pour `agora-scout`), pas une conséquence automatique de ce change.
- Le service s'arrête proprement : fermeture des bases, aucune écriture, aucun fichier temporaire
  persistant.
