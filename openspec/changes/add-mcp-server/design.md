# Design — add-mcp-server

> **Recentrage effectué à la demande explicite de l'utilisateur.** Ordre de lecture resserré : D0 (cadrage), D1 (transport), D2 (catalogue), D3 (bornes), D4 (ancrage), D5 (fraîcheur), D6 (concurrence, contrat honnête), D7 (continuation), D8 (recollement), D9 (preuves brutes — reportées), D10 (confidentialité).

## D0 — Cadrage v1 re-scopé

Première livraison **réduite, demandée explicitement** : rendre le CLI accessible aux agents sans transformer cette façade en moteur de restitution généraliste. La sécurité, la lecture complète accessible et la sémantique de `at` restent requises ; les totaux exhaustifs obligatoires et le déterminisme de l'enveloppe technique restent hors contrat v1.

- **En v1 (MVP)** : `sdig_search`, `sdig_read`, `sdig_status` sur transport Streamable HTTP loopback (D1).
- **Hors MVP, à réexaminer selon l'usage et sur accord explicite** : `sdig_raw` avec ses garde-fous (D9), pagination des résultats de recherche, timeout applicatif strict avec arrêt observable et concurrence >1 (D6). Ce sont des extensions possibles, pas des livraisons déjà commandées. Les garanties de confidentialité et les descriptions des outils (D10) restent obligatoires dès le MVP.
- **Jalon J-MCP** : usage solo local validé sur PC, après les prérequis d'intégrité du lot A de `scale-corpus`. La validation CLI sur PC peut précéder le MCP ; les bancs étendus ne bloquent pas cette première utilisation.

Ce change reste **documentaire**. Aucun SDK installé, aucun code MCP, aucun serveur lancé ni manifeste modifié. Les nombres ci-dessous sont des plafonds de conception ; leur évolution doit être documentée et validée, jamais changée silencieusement dans le code.

## D1 — Transport et confinement HTTP

- Streamable HTTP, Node/ESM, SDK MCP officiel dont le paquet et la version publiée seront vérifiés puis épinglés dans le change d'implémentation. Ne pas présumer ici de la ligne majeure disponible.
- Écoute exclusive `127.0.0.1:18767` ; toute autre adresse configurée est refusée. Aucun appel réseau sortant (modèle, proxy, API, télémétrie).
- Validation stricte de `Host` : formes loopback et port attendus uniquement. `Origin` absent est permis pour les clients non navigateur ; s'il est présent, il doit être une origine loopback valide, sinon refus avant tout travail. Les valeurs malformées, dont `Origin: null`, sont refusées.
- Ces contrôles limitent le rebinding DNS et les origines externes ; **ils ne bloquent pas un client local ni une page d'origine locale admise**. Loopback n'est pas une authentification.
- Token statique optionnel, exigé sur chaque requête lorsqu'il est configuré, comparaison en temps constant et jamais journalisé. Sans token, pas d'authentification des clients locaux.
- Le corpus, l'index et la base source ne sont jamais écrits par le serveur. SQLite ouvert en lecture seule ; ne pas en déduire une absence absolue de contention avec les opérations CLI.
- Aucun deuxième transport ni installation automatique : un seul mode de lancement, documenté, validé par un client MCP réel sur PC au jalon commun. L'ajout au manifeste Termux reste une décision propriétaire distincte (D11).

## D2 — Catalogue et responsabilités

| Outil | Paramètres initiaux | Réponse et suite |
|---|---|---|
| `sdig_search` | `query` obligatoire (≤ 512 caractères), `repo`, `session` (préfixe littéral échappé), `after`, `before`, `model`, `role`, `agent`, `source`, `limit` (défaut 10, max 50), `ctx` (0–5) | meilleurs hits bornés, groupés par session, extraits et identifiants complets ; sans curseur ; texte complet via `sdig_read` |
| `sdig_read` | `session` obligatoire, `around`, `ctx` (0–50), `tail` (1–200), `at`, `chars` (1–20 000), `full` | vue temporelle, fragments de messages et curseur de continuation |
| `sdig_status` | aucun | compteurs, watermark, état de l'index ; aucun chemin local |

Seul `sdig_read` accepte `cursor`. Pour continuer une lecture, l'appelant fournit le curseur seul ; il n'a pas à répéter les paramètres initiaux. Un mélange curseur + paramètres de nouvelle requête est refusé (`invalid_params`). Un curseur soumis à `search` ou `status` est également refusé : aucune pagination de recherche, même partielle, n'est à implémenter dans le MVP.

`sdig_search` accepte `source` (`opencode`|`pi`), de sémantique identique au filtre CLI du change pi-adapter — messages et titres synthétiques — ; un nom inconnu rend zéro hit, pas une erreur. `agent` filtre le champ exact : en v0 pi ce champ est `null`, donc un filtre non nul exclut tous les messages pi ; les descriptions d'outils le documentent. La v1 n'expose ni le scan `--raw` du CLI, ni `sdig_raw(partId)` (reporté, D9). La recherche top-k n'est pas un export exhaustif ; elle ne garantit pas pour autant que SQLite n'effectuera aucun parcours coûteux.

La recherche fournit un moyen de repérer les sources, **pas un second lecteur intégral**. Un extrait coupé porte son caractère d'extrait et une référence exploitable (session et message) vers `read`. Les résultats synthétiques de titre sont identifiés comme tels et pointent vers la session, pas vers un faux message. Les voisins de contexte sont eux aussi des extraits référencés ; le texte complet reste accessible par `sdig_read`.

Pour **affiner** une recherche, l'appelant précise la requête ou ajoute des filtres restrictifs (`repo`, `session`, `source`, `after`/`before`, `model`, `role`, `agent`). `limit` et `ctx` ajustent le nombre de hits et leur contexte, sans accès garanti à toutes les correspondances. La description de l'outil annonce cette limite. L'ordre reste stable : scores égaux départagés par identifiant canonique complet en ordre binaire ; la sélection précède le regroupement par session.

Les types invalides, nombres non entiers, valeurs négatives et chaînes dépassant leur taille permise sont refusés avant travail. Une limite numérique valide au-dessus du maximum est ramenée au plafond et cette adaptation est signalée. `ctx=0` est valide ; les tailles de pages nulles sont refusées.

Aucune sous-commande d'écriture, aucun shell, aucune URL ou chemin de fichier choisi par l'appelant, aucune resource/prompt donnant accès au système de fichiers. Les filtres textuels sont des valeurs de recherche, pas des adresses ou destinations.

## D3 — Bornes et compteurs honnêtes

Plafonds par appel : **50 hits par recherche** (top-k sans pagination), **200 messages distincts**, **50 voisins de contexte par côté dans read** (`ctx≤50`, et `ctx≤5` dans search), **20 000 caractères de texte par message**, **524 288 octets de réponse MCP sérialisée UTF-8**. Le budget total inclut les métadonnées, curseurs et éventuelles représentations dupliquées dans l'enveloppe MCP ; les fragments sont réduits avant sérialisation finale pour le respecter.

- Priorité d'assemblage : les hits précèdent leurs voisins de contexte ; les voisins remplissent le budget restant, avec coupures et comptes explicites par dimension. Si le budget impose moins de hits que `limit`, la réduction est signalée, sans curseur de recherche. Dans `read`, chaque page non finale avance effectivement. Un élément dont la représentation minimale excède seule le budget total produit une erreur bornée, pas une boucle sans progrès.
- `truncated` identifie les dimensions coupées, les quantités retenues exactes et, pour chacune, le total exact s'il est connu, sinon `null`. Aucun total estimé, aucun `COUNT` exhaustif obligatoire seulement pour renseigner un compteur.
- L'absence de total exact ne signifie pas qu'il n'existe plus de résultats. Search signale la sélection top-k et l'éventuelle réduction par budget ; un total inconnu ne devient pas une affirmation d'exhaustivité. Aucun `nextCursor` n'est rendu par search.
- Dans `read` seulement, `truncated.nextCursor` est présent s'il reste des messages ou fragments dans la vue choisie ; il est absent sur la dernière page. Une lecture d'un élément supplémentaire peut établir l'existence de la suite sans comptage global. Une coupure d'extrait de recherche renvoie vers `read`.
- `full` augmente le budget de fragment jusqu'au plafond ; il ne désactive ni la borne par message ni le budget total. La suite reste accessible via le curseur : **aucun mode tronqué présenté comme complet** (`full` coupé porte explicitement sa suite).
- Les comptes `anchor`, `maskedCount`, `visible` et `total` déjà fournis par la lecture CLI conservent leur sémantique ; la permission de total inconnu ne retire pas ces informations disponibles.

## D4 — Lecture temporelle

`sdig_read` appelle la logique partagée de `read --at` : UTC, validation calendaire stricte, ancre vide refusée, instant exact inclus, masquage avant fenêtrage, `anchor` et `maskedCount` explicites. Le curseur conserve l'ancre et la fenêtre ; il ne rend jamais visibles des messages exclus par cette vue.

Le masquage n'est pas un contrôle d'accès : une nouvelle requête sans ancre reste possible. Aucune détection ni qualification de mutation d'état. Le lecteur choisit sa borne ; ancrer sur une question peut masquer la réponse postérieure qui documente l'état.

## D5 — Fraîcheur et déterminisme utile

Les résultats portent `freshness: { sources, indexMtime, corpusVersion }` : `sources` est indexé par source — opencode expose ses deux watermarks, pi son jeton déterministe et son nombre de fichiers suivis si connu —, valeurs absentes ou `null` si indisponibles. `indexMtime` est un diagnostic, jamais une identité de génération.

Pour les continuations, l'identité de la génération **publiée de la vue** et ses watermarks par source lient les pages à l'état lu ; ne pas émettre de curseur prétendument sûr si cet état ne peut pas être identifié. Une vue en avance sur `state.json` (COMMIT avant écriture d'état) s'interprète selon le protocole de publication, jamais par comparaison d'ordre du jeton pi : **divergence jeton pi = `view_unavailable` temporaire jusqu'à réconciliation** — le curseur n'est émis que si la vue est identifiable ; l'appelant relance après réconciliation ; une lecture réussie rend des données **cohérentes**, pas une disponibilité permanente. Un changement détecté pendant la lecture invalide la page plutôt que d'assembler des générations différentes ; toutes les requêtes SQL d'une page partagent un snapshot.

À corpus/index et paramètres identiques, les données d'un appel réussi et leur ordre sont identiques ; les curseurs, identifiants techniques et durées peuvent différer. Ajouter un champ est compatible ; retirer/renommer un champ ou réduire une borne exige un changement de spec. Une donnée indisponible n'est jamais inventée.

## D6 — Concurrence, timeout et durée : contrat honnête

Le service est **mono-travail** : un seul appel d'outil actif à la fois. À l'admission d'un appel, si le créneau est occupé, le service répond `busy` sans ajouter de file applicative. S'il est libre, l'appel peut démarrer. Ce contrat ne prétend pas supprimer les tampons du transport : une requête arrivée pendant un calcul synchrone peut n'être traitée qu'après sa fin, puis être admise.

- Les limites de taille (D3) bornent le **volume** des réponses, **pas la durée du calcul** : un `LIMIT` SQL ne fixe pas de borne de temps.
- Aucun timeout applicatif garanti dans le MVP. Un `Promise.race` ne doit pas être présenté comme un arrêt du calcul ; un timeout ou une déconnexion du client ne prouve pas que le travail serveur est arrêté.
- Pendant un calcul synchrone, le serveur peut être non réactif : **aucune promesse de `busy` immédiat**, d'annulation immédiate ou de délai de réponse. Une requête lente peut retarder tous les outils.
- L'arrêt et la reprise sont manuels et documentés. Le MCP étant en lecture seule, son interruption ne déclenche ni réparation ni réconciliation du corpus. Il ferme ses connexions à l'arrêt normal ; aucun travail de fond détaché ne doit survivre à son arrêt. Un état d'ingestion déjà interrompue relève du CLI, jamais d'une réparation implicite MCP.
- Timeout strict et concurrence >1 restent hors MVP. S'ils deviennent nécessaires, un change devra vérifier l'isolation et l'arrêt observable sur la pile réelle, y compris SQLite natif : pas de résultat partiel après timeout, pas de créneau libéré avant confirmation d'arrêt, pas de travail orphelin.

Codes applicatifs : `unknown_session`, `invalid_anchor`, `invalid_cursor`, `stale_cursor`, `invalid_params`, `view_unavailable`, `forbidden_host`, `busy`, `internal`. Aucun code `timeout` ni `invalid_part` dans le MVP. Les erreurs ne recopient ni archive, ni requête libre, ni secret, ni chemin local ; seuls des identifiants validés peuvent être repris. Une requête sans terme exploitable donne `invalid_params`. Les erreurs du protocole MCP restent distinctes.

## D7 — Continuation de read uniquement

- `search` : aucun curseur ni pagination dans le MVP. Extraits et voisins référencés vers `read`, affinage par requête et filtres.
- `read` : pagination de la vue choisie et fragmentation des messages longs, avec identifiant de message, offset et indicateur de fin de message. Une même vue peut couvrir plusieurs pages ; aucun contenu de cette vue ne devient inaccessible à cause d'un plafond.
- Pagination à la requête et fragments extraits avant construction de la réponse : l'implémentation ne matérialise pas une session entière pour la découper (le chargement intégral actuel du lecteur CLI est un fait de code, pas un contrat) ; un élément minimal excédant le budget donne une erreur bornée.
- Curseur opaque, inerte, validé et lié à l'outil, à la requête initiale, à sa position et à la génération. Curseur altéré/étranger : `invalid_cursor` ; génération changée : `stale_cursor`, relancer la requête initiale. L'identité binaire des curseurs entre deux appels n'est pas exigée.
- Si l'implémentation stocke un état de curseur, sa durée de vie et ses bornes mémoire seront documentées ; un curseur perdu/expiré est refusé **explicitement** — jamais réinterprété comme une nouvelle requête.

## D8 — Recollement exact et encodage

- Le schéma d'implémentation documentera les unités des offsets (caractères ou octets) et l'encodage. Tests de recollement exact : pas de trou, doublon ou caractère Unicode perdu, y compris accents/emoji et coupure par budget global. **Ces tests restent dans le MVP read** (read paginé/fragments) ; ils ne sont pas repoussés avec raw.
- La spec de continuation (fragments exacts sans caractère perdu) couvre `read`. Une extension future à `raw` héritera de la même exigence de recollement octet par octet (D9).

## D9 — Preuves brutes : reporté, notes conservées

`sdig_raw` est **hors MVP ; son ajout reste éventuel et soumis à un nouvel accord**. Le CLI `raw` reste disponible. Les notes de sécurité antérieures sont conservées pour une extension future soumise à accord ; rien de ce qui suit n'est une tâche bloquante du MVP :

- Catalogue fermé par défaut : raw absent, activable explicitement (`expose_raw: true`, journalisé). Aucune continuation ne contourne une désactivation ultérieure.
- `partId` est une entrée non fiable : validation syntaxique bornée des familles reconnues (identifiants opencode hérités, `pi:<sessionId>:<id local>` qualifié par session), existence dans les références de la vue, fichier dérivé de cette référence uniquement — la validation précède toute dérivation de chemin. Les partIds orphelins pi (exécutions sans `rawRef`) ne sont pas référencés dans la vue : à refuser `invalid_part` dans cette extension, sans parité avec la lecture explicite du CLI. Les caractères admis et longueurs maximales sont épinglés dans le change d'implémentation après confrontation aux fixtures des deux adaptateurs.
- Résolution confinée à `raw/`, rejet des traversées, chemins absolus, liens symboliques et fichiers spéciaux. Contrôler le chemin canonique, l'ouverture sans suivi du lien final (`O_NOFOLLOW`) et le type du fichier effectivement ouvert ; expliciter les hypothèses sur les répertoires parents et tester les substitutions de fichier. Ne pas prétendre qu'un `realpath` préalable suffit à supprimer les courses.
- Réponse `unvetted: true` et bornée, y compris en continuation ; fragmentation avec offsets explicites (`head`, `maxBytes` bornent chaque page, pas la quantité totale récupérable) ; recollement sans perte d'octet.
- Une continuation raw est liée à l'identité du fichier ouvert et du contenu lu ; invérifiable = `stale_cursor`. Une page touchant le marqueur d'ingestion porte l'avertissement du protocole de publication, sans contenu privé ; le snapshot SQLite n'est pas un snapshot des fichiers `raw/`.

## D10 — Confidentialité et contenu non fiable

Liste autorisée des journaux : nom d'outil, paramètres numériques de limites/fenêtres/offsets, identifiants techniques validés, compteurs connus, durée, code d'erreur. Pas de `query`, filtre libre, curseur, token, texte de message ni sortie brute. Debug `log_content: true` uniquement sur activation explicite annoncée ; jamais de secret d'authentification journalisé.

**Toute lecture peut exposer des secrets**, y compris les messages ordinaires. Aucun filtrage de secrets promis. Le service ne contacte aucun modèle ; le client peut transmettre ses réponses au fournisseur du modèle appelant. Une limite de taille n'est pas une protection contre la présence d'un secret.

Les descriptions des trois outils sont obligatoires dès le MVP. Elles rappellent que le contenu peut inclure des secrets et être transmis au fournisseur du modèle, et que messages, commandes et sorties sont des **données non fiables**, jamais des instructions à suivre ou à exécuter. Aucun outil du service n'exécute ce contenu. L'absence de raw n'anonymise pas les messages ordinaires.

Aucun outil ne lit les fichiers du jeu d'évaluation. Cette fermeture ne garantit pas l'absence, dans l'historique, d'extraits éventuellement copiés auparavant ; le service ne prétend pas les détecter.

## D11 — Supervision et livraison

Lancement manuel documenté, puis validation sur PC (jalon commun). Ajout au manifeste Termux `~/.config/agora/servers.sh` et activation durable uniquement sur décision propriétaire distincte — **hors MVP** ; l'usage validation cible est le PC, pas le téléphone. Aucune dépendance à Agora pour le lancement PC : journaux techniques sur stderr par défaut. Une éventuelle intégration Agora choisira sa destination séparément. Arrêt manuel documenté avec fermeture des connexions et sans travail détaché survivant ; aucune écriture dans le corpus/index/base source, aucun temporaire persistant laissé par le service.

Le change d'implémentation vérifiera le SDK et ses contrats avant installation. Ni code réseau, ni dépendance, ni démarrage ne découlent automatiquement de la validation de cette spec.
