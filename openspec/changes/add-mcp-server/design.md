# Design — add-mcp-server

## D0 — V1 recentrée (20/09)

Décision utilisateur : rendre le CLI accessible aux agents, sans transformer cette façade en moteur de restitution généraliste. La sécurité, la lecture complète accessible et la sémantique de `at` restent requises. Les totaux exhaustifs obligatoires, les partiels après timeout et le déterminisme de l'enveloppe technique sont retirés du contrat v1.

Ce change reste **documentaire**. Aucun SDK installé, aucun code MCP, aucun serveur lancé ni manifeste modifié. Les nombres ci-dessous sont des plafonds de conception ; leur évolution doit être documentée et validée, pas changée silencieusement dans le code.

## D1 — Transport et confinement HTTP

- Streamable HTTP, Node/ESM, SDK MCP officiel dont le paquet et la version publiée seront vérifiés puis épinglés dans le change d'implémentation. Ne pas présumer ici de la ligne majeure disponible.
- Écoute exclusive `127.0.0.1:18767` ; toute autre adresse configurée est refusée. Aucun appel réseau sortant (modèle, proxy, API, télémétrie).
- Validation stricte de `Host` : formes loopback et port attendus uniquement. `Origin` absent est permis pour les clients non navigateur ; s'il est présent, il doit être une origine loopback valide, sinon refus avant tout travail. Les valeurs malformées, dont `Origin: null`, sont refusées.
- Ces contrôles limitent le rebinding DNS et les origines externes ; **ils ne bloquent pas un client local ni une page d'origine locale admise**. Loopback n'est pas une authentification.
- Token statique optionnel, exigé sur chaque requête lorsqu'il est configuré, comparaison en temps constant et jamais journalisé. Sans token, pas d'authentification des clients locaux.
- Le corpus, l'index et la base source ne sont jamais écrits par le serveur. SQLite ouvert en lecture seule ; ne pas en déduire une absence absolue de contention avec les opérations CLI.

## D2 — Catalogue et responsabilités

| Outil | Paramètres initiaux | Réponse et suite |
|---|---|---|
| `sdig_search` | `query` obligatoire (≤ 512 caractères), `repo`, `session`, `after`, `before`, `model`, `role`, `agent`, `limit` (défaut 10, max 50), `ctx` (0–5) | hits groupés par session, extraits et identifiants complets ; curseur pour les hits suivants ; texte complet via `sdig_read` |
| `sdig_read` | `session` obligatoire, `around`, `ctx` (0–50), `tail` (1–200), `at`, `chars` (1–20 000), `full` | vue temporelle, fragments de messages et curseur de continuation |
| `sdig_raw` | `partId` obligatoire, `head` (1–2 000 lignes par page), `maxBytes` (1–65 536 octets par page) | fragments de preuve, `unvetted: true`, continuation ; outil absent par défaut |
| `sdig_status` | aucun | compteurs, watermark, état de l'index ; aucun chemin local |

Les trois outils paginés acceptent aussi `cursor`. Pour continuer, l'appelant fournit le curseur seul ; il n'a pas à répéter les paramètres initiaux. Un mélange curseur + paramètres de nouvelle requête est refusé (`invalid_params`). `status` n'a pas de curseur.

La recherche fournit un moyen de repérer les sources, **pas un second lecteur intégral**. Un extrait coupé porte son caractère d'extrait et une référence exploitable (session et message) vers `read`. Les résultats synthétiques de titre sont identifiés comme tels et pointent vers la session, pas vers un faux message. Les voisins de contexte sont eux aussi des extraits référencés.

Les types invalides, nombres non entiers, valeurs négatives et chaînes dépassant leur taille permise sont refusés avant travail. Une limite numérique valide au-dessus du maximum est ramenée au plafond et cette adaptation est signalée. `ctx=0` est valide ; les tailles de pages nulles sont refusées.

Aucune sous-commande d'écriture, aucun shell, aucune URL ou chemin de fichier choisi par l'appelant, aucune resource/prompt donnant accès au système de fichiers. Les filtres textuels sont des valeurs de recherche, pas des adresses ou destinations.

## D3 — Bornes et compteurs honnêtes

Plafonds par appel : **50 hits**, **200 messages distincts**, **50 voisins de contexte par côté dans read** (`ctx≤50`, et `ctx≤5` dans search), **20 000 caractères de texte par message**, **65 536 octets de preuve brute**, **524 288 octets de réponse MCP sérialisée UTF-8**. Le budget total inclut les métadonnées, curseurs et éventuelles représentations dupliquées dans l'enveloppe MCP ; les fragments sont réduits avant sérialisation finale pour le respecter.

- `truncated` identifie les dimensions coupées, les quantités retenues exactes et, pour chacune, le total exact s'il est connu, sinon `null`. Aucun total estimé, aucun `COUNT` exhaustif obligatoire seulement pour renseigner un compteur.
- L'absence de total exact ne signifie pas qu'il n'existe plus de résultats. La continuation de liste peut utiliser une lecture d'un élément supplémentaire pour savoir si une page suivante existe, sans compter tous les hits.
- `nextCursor` est placé dans `truncated.nextCursor` quand la liste des hits ou le contenu de lecture a une suite. Une simple coupure d'extrait de recherche renvoie vers `read` : elle n'exige pas de curseur sur ce texte.
- `full` augmente le budget de fragment jusqu'au plafond ; il ne désactive ni la borne par message ni le budget total. La suite reste accessible via le curseur.
- Les comptes `anchor`, `maskedCount`, `visible` et `total` déjà fournis par la lecture CLI conservent leur sémantique ; la permission de total inconnu ne retire pas ces informations disponibles.

## D4 — Lecture temporelle

`sdig_read` appelle la logique partagée de `read --at` : UTC, validation calendaire stricte, ancre vide refusée, instant exact inclus, masquage avant fenêtrage, `anchor` et `maskedCount` explicites. Le curseur conserve l'ancre et la fenêtre ; il ne rend jamais visibles des messages exclus par cette vue.

Le masquage n'est pas un contrôle d'accès : une nouvelle requête sans ancre reste possible. Aucune détection ni qualification de mutation d'état. Le lecteur choisit sa borne ; ancrer sur une question peut masquer la réponse postérieure qui documente l'état.

## D5 — Preuves brutes et fichiers

- `sdig_raw` absent du catalogue par défaut ; activation explicite `expose_raw: true`, journalisée. Aucune continuation ne contourne une désactivation ultérieure de l'outil.
- `partId` est une entrée non fiable : format strict, existence dans les références du corpus, fichier dérivé de cette référence uniquement.
- Résolution confinée à `raw/`, rejet des traversées, chemins absolus, liens symboliques et fichiers spéciaux. Contrôler le chemin canonique, l'ouverture sans suivi du lien final (`O_NOFOLLOW`) et le type du fichier effectivement ouvert ; expliciter les hypothèses sur les répertoires parents et tester les substitutions de fichier. Ne pas prétendre qu'un `realpath` préalable suffit à supprimer les courses.
- Réponse `unvetted: true` et bornée, y compris en continuation. Le CLI n'est pas modifié.

## D6 — Concurrence et erreurs

Deux appels de travail simultanés par défaut (configuration bornée et documentée à l'implémentation). Au-delà : `busy`, sans file non bornée. Un travail en cours d'arrêt occupe toujours son créneau.

Codes stables des erreurs applicatives : `unknown_session`, `invalid_part`, `invalid_anchor`, `invalid_cursor`, `stale_cursor`, `invalid_params`, `forbidden_host`, `busy`, `timeout`, `internal`. Les erreurs ne recopient ni contenu d'archive, ni requête libre, ni secret. Les identifiants ne peuvent être repris dans une erreur ou un journal qu'après validation de leur format. Les erreurs de protocole MCP restent distinctes.

## D7 — Fraîcheur et déterminisme utile

Les résultats de lecture portent `freshness: { watermarkMessage, watermarkSession, indexMtime, corpusVersion }`, valeurs absentes ou `null` si indisponibles. Pour les continuations, une empreinte de génération vérifiée lie les pages à l'état lu ; ne pas émettre de curseur prétendument sûr si cet état ne peut pas être identifié. Un changement détecté pendant la lecture invalide la page plutôt que d'assembler des générations différentes.

À corpus/index et paramètres identiques, **les données d'un appel achevé avec succès et leur ordre** sont identiques. Les curseurs opaques, identifiants de requête et durées peuvent différer ; timeout et saturation sont des événements d'exécution, pas des données déterministes. L'ordre des hits doit être stable, avec départage des scores égaux par identifiant ; la pagination précède le regroupement de présentation par session.

Ajouter un champ est compatible ; retirer/renommer un champ ou réduire une borne exige un changement de spec. Une donnée indisponible n'est jamais inventée.

## D8 — Continuation adaptée à chaque outil

- `search` : pagination **de la liste des hits**, filtres et ordre conservés. Pas de texte intégral fragmenté dans les hits ni dans leur contexte ; référence vers `read` pour ce besoin.
- `read` : pagination de la vue choisie et fragmentation des messages longs, avec identifiant de message, offset et indicateur de fin de message. Une même vue peut couvrir plusieurs pages ; aucun contenu de cette vue ne devient inaccessible à cause d'un plafond.
- `raw` actif : fragmentation de la preuve avec offsets explicites. `head` et `maxBytes` bornent chaque page, pas la quantité totale récupérable.
- Le schéma d'implémentation documentera les unités des offsets (caractères ou octets) et l'encodage. Tests de recollement exact : pas de trou, doublon ou caractère Unicode perdu, y compris accents/emoji et coupure par budget global. La preuve brute se reconstitue sans perte d'octet.
- Curseur opaque, inerte, validé et lié à l'outil, à la requête initiale, à sa position et à la génération. Curseur altéré/étranger : `invalid_cursor` ; génération changée : `stale_cursor`, relancer la requête initiale.
- L'identité binaire des curseurs entre deux appels n'est pas exigée. Si l'implémentation stocke un état de curseur, sa durée de vie et ses bornes mémoire seront documentées ; un curseur perdu/expiré est refusé explicitement, jamais réinterprété comme une nouvelle requête.

## D9 — Timeout simple, arrêt réel

Délai par appel : 5 s par défaut (configurable). Le travail synchrone de lecture/SQLite doit être isolé du serveur HTTP dans une unité dont l'arrêt peut être demandé et observé (worker ou processus, choix justifié et testé sur la pile réelle). Un `Promise.race` seul n'arrête rien ; un `LIMIT` SQL borne les résultats, **pas la durée du calcul**.

À expiration : erreur `timeout`, **aucun résultat partiel ni curseur issu du calcul interrompu** ; demande d'arrêt du travail. Le créneau n'est rendu qu'après confirmation de l'arrêt effectif. Pendant cette phase, une saturation continue de donner `busy`. Les résultats tardifs sont ignorés. Si l'arrêt échoue, l'unité reste indisponible et l'incident est signalé : ne pas lancer du travail supplémentaire en prétendant le créneau libre.

La v1 ne promet pas une terminaison instantanée à la milliseconde. Tests : timeout sans payload partiel, arrêt/absence de travail orphelin, maintien du plafond de concurrence pendant l'arrêt, réutilisation après confirmation, comportement avec les appels natifs SQLite. Des plafonds de travail restent utiles, sans servir de preuve de délai maximal.

## D10 — Confidentialité et contenu non fiable

Liste autorisée des journaux : nom d'outil, paramètres numériques de limites/fenêtres/offsets, identifiants techniques validés (session/preuve), compteurs connus, durée, code d'erreur. Pas de `query`, filtre libre, curseur, token, texte de message ni sortie brute. Debug `log_content: true` uniquement sur activation explicite annoncée ; jamais de secret d'authentification journalisé.

**Toute lecture peut exposer des secrets**, y compris les messages ordinaires. Aucun filtrage de secrets promis. Désactiver `raw` réduit une surface, mais n'anonymise pas les résultats. Le service ne contacte aucun modèle ; le client peut transmettre ses réponses au fournisseur du modèle appelant. Une limite de taille n'est pas une protection contre la présence d'un secret.

Les descriptions des outils rappellent que messages, commandes et sorties sont des **données non fiables**, jamais des instructions à suivre ou à exécuter. Aucun outil du service n'exécute ce contenu.

Aucun outil ne lit les fichiers du jeu d'évaluation. Cette fermeture ne garantit pas l'absence, dans l'historique, d'extraits éventuellement copiés auparavant ; le service ne prétend pas les détecter.

## D11 — Supervision et livraison

Lancement manuel documenté, puis intégration cliente MCP sur fixtures. Ajout au manifeste Termux `~/.config/agora/servers.sh` et activation durable uniquement sur décision propriétaire distincte. Logs sous `~/.agora/log/`. Arrêt propre des unités de travail et des bases, aucune écriture dans le corpus/index/base source, aucun temporaire persistant laissé par le service.

Le change d'implémentation vérifiera le SDK et ses contrats avant installation. Ni code réseau, ni dépendance, ni démarrage ne découlent automatiquement de la validation de cette spec.
