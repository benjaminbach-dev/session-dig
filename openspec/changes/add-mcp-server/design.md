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
  compteurs **exacts** (retenus / totaux) et l'action qui élargit (`limit`, `chars`, `head`, `full`) ;
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
- **Délai par appel** : 5 s par défaut (configurable), retour **partiel** avec `stop_reason: timeout`
  plutôt qu'un blocage. L'index est local, la mesure du 15/09 donne une requête type sous 11 ms ;
  5 s est un garde-fou, pas une contrainte de performance.
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

## D8 — Journaux et supervision

- Journaux = **métadonnées** (outil, paramètres, compteurs, durée, code d'erreur) ; **aucun contenu**
  de message ni de sortie d'outil n'est journalisé par défaut. Un mode debug (`log_content: true`,
  jamais par défaut) existe pour le développement et le dit.
- Démarrage par le **manifeste Termux** (`agora_server_debian session-dig …`), logs
  `~/.agora/log/session-dig.log`, arrêt par `agora_stop` — la modification du manifeste est une
  **décision propriétaire** (comme pour `agora-scout`), pas une conséquence automatique de ce change.
- Le service s'arrête proprement : fermeture des bases, aucune écriture, aucun fichier temporaire
  persistant.
