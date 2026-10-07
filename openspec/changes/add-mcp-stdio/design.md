# Design — add-mcp-stdio

## D0 — Ce que ce change est et n'est pas

Ce change est **documentaire** : il fige le cadrage minimal d'un second transport
stdio pour le serveur MCP de session-dig, **sans implémenter quoi que ce soit**.
Décision du principal du 06/10/2026 : le transport est voulu, le change doit être
écrit, relu et corrigé ; **implémentation interdite tant qu'elle n'est pas
autorisée explicitement**. Il ne touche ni aux handlers métier, ni au catalogue
d'outils, ni aux schémas, ni aux bornes, ni au transport HTTP, ni au CLI hors du
flag additif `--stdio`.

Le besoin est un **constat d'usage du 06/10/2026** : le mode HTTP impose un
lancement manuel avant la session cliente, une connexion figée au démarrage du
client et une configuration manuelle par URL. Le stdio supprime ces trois
frictions en faisant du serveur un **processus enfant du client**.

Décision historique explicitement **levée** : le design `add-mcp-server` avait
exclu « aucun deuxième transport » par YAGNI d'alors. Ce change relève cette
exclusion **sur besoin démontré** (lancement manuel, ordre de démarrage, config
par URL) ; il ne la contourne pas et ne prétend pas que l'exclusion d'origine
était fausse dans son contexte.

## D1 — Sélection du transport et surface CLI

- Le **mode par défaut reste HTTP** : `sdig mcp` sans flag se comporte exactement
  comme aujourd'hui (écoute exclusive `127.0.0.1:18767`, route `/mcp`).
- Le mode stdio s'active par un flag **additif** : `sdig mcp --stdio`.
- Les surcharges **communes** `--home`, `--db`, `--pi-dir` restent admises dans les
  deux modes, avec la même sémantique. Le jeton `SESSION_DIG_MCP_TOKEN` reste
  **sans effet** en stdio (aucune requête HTTP, aucune authentification de client
  local à effectuer) ; sa présence **bien formée** ne SHALL pas faire échouer le
  démarrage stdio, mais elle ne SHALL jamais être présentée comme une protection
  en stdio. Un jeton **malformé** est refusé au démarrage **dans les deux modes**
  (comportement existant inchangé, `resolveToken`).
- **Un seul mode par processus** : `--stdio` et toute option de connexion HTTP
  (actuellement aucune : hôte/port sont des constantes) sont **mutuellement
  exclusifs**. Si des options de connexion HTTP sont ajoutées plus tard, leur
  combinaison avec `--stdio` SHALL être refusée explicitement **avant** toute
  création de transport. Un flag `--stdio` dupliqué ou une valeur inattendue SHALL
  être refusé sans écho (même discipline que le parser dédié actuel).
- La sélection SHALL être décidée **avant** toute ouverture de transport, pour
  qu'aucun socket ne soit lié puis abandonné en mode stdio.

## D2 — Cycle de vie

- **HTTP (inchangé)** : lancement manuel `sdig mcp` ; arrêt par `SIGINT`/`SIGTERM`
  (`server.close()` terminé, attente du travail actif, purge du cache de curseurs,
  sortie 0 ou 1 selon échec de fermeture). Aucun travail de fond détaché.
- **stdio (nouveau)** : le serveur est lancé par le **client MCP** (spawn d'un
  processus enfant). Sa durée de vie est **liée au client** : la fermeture de
  l'entrée standard (EOF) ou la mort du client termine le serveur. C'est conforme
  au principe du projet « aucun travail détaché ne survit ».
- **Arrêt propre conservé** : lorsqu'un signal `SIGINT`/`SIGTERM` est reçu en
  stdio, le chemin d'arrêt normal reste appliqué (attente du travail actif, purge
  du cache), comme en HTTP. La mort du client (sans signal) est un arrêt brutal
  du processus : aucun travail détaché ne doit survivre, mais aucune promesse de
  vidage complet des réponses en vol n'est faite.
- **Aucune supervision, aucun redémarrage automatique** : si le client tue ou
  relance le serveur, c'est le client qui en décide. Le service ne s'auto-relance
  pas et n'écrit aucune configuration cliente.

## D3 — Journalisation et canal protocole

- **Contrainte dure** : en stdio, **stdout ne porte QUE des messages du protocole
  MCP**. Toute journalisation, avertissement, trace, message d'erreur ou sortie
  de diagnostic SHALL aller sur **stderr**. Une écriture parasite sur stdout
  corrompt le flux du client : c'est un **défaut**, pas un détail cosmétique.
- **État actuel favorable** : la journalisation de production est déjà
  exclusivement sur stderr (`createSafeLogger` par défaut, `console.error`,
  `process.stderr.write`). Le contrat `app_error`/`tool`/`guard` est à champs et
  valeurs épinglés et n'écrit pas sur stdout.
- **Vérification obligatoire à l'implémentation** : recenser **toutes** les
  écritures stdout atteignables en mode stdio (y compris `console.log` de
  messages d'aide, avertissements de dépendances, sorties d'outillages tiers ou
  de `npm`/Node) et garantir qu'aucune ne fuit. Deux points identifiés au
  cadrage : (1) `sdig mcp --help` écrit actuellement l'aide sur stdout — l'aide
  n'est pas un message MCP ; elle SHALL être redirigée sur stderr ou refusée en
  mode stdio ; (2) toute aide ou annonce de démarrage SHALL rester hors stdout.
- **Budget d'enveloppe** : le budget sérialisé de **524 288 octets** reste
  inchangé ; en stdio il se mesure sur les messages écrits sur stdout. Aucune
  borne n'est réduite ni élargie par le transport. Nuance consignée (revue du
  06/10) : le point de mesure est `buildToolResult` (avant cadrage transport) et
  le cadrage stdio ajoute un `\n` par message — le cas limite d'un message
  exactement à budget sera couvert au recensement d'implémentation, sans
  élargir la borne.
- **Validation protocolaire** (différence assumée, revue du 06/10) : en HTTP, une
  pré-validation dédiée précède le SDK (méthodes, ids, corps borné, version de
  protocole — `guards.js`) ; en stdio, c'est le SDK bas niveau qui parse et borne
  les trames. Les validations **des arguments d'outils** sont identiques dans les
  deux modes (validateurs partagés) ; cette répartition ne crée aucun écart de
  validation métier, mais elle sera documentée telle quelle.
- Aucun contenu privé, `query`, filtre libre, curseur, chemin ou jeton n'est
  journalisé : la liste autorisée existante reste la référence, valable dans les
  deux modes.

## D4 — Garde-fous et confinement

- **HTTP (inchangé)** : contrôles `Host` (formes loopback et port attendus),
  `Origin` (absent permis ; présent doit être loopback valide ; `null` et valeurs
  externes/malformées refusés), jeton statique optionnel comparé en temps
  constant, refus avant tout travail. Rappel : ce n'est **pas** une
  authentification et cela ne protège pas de tous les clients locaux.
- **stdio** : `Host`, `Origin` et jeton ne s'appliquent **pas** — il n'existe ni
  socket HTTP, ni en-tête, ni requête réseau. Ce n'est **pas** une réduction de
  garanties : le stdio est **plus confiné** que le HTTP car il n'écoute **aucun
  port**, n'est joignable par aucun autre processus que son parent, et ne peut pas
  être atteint par une page locale ni par rebinding DNS. Le client est le
  **propriétaire du processus** ; il n'y a pas de frontière réseau à défendre.
- **Admission mono-travail** : conservée en stdio. Un client unique peut émettre
  des requêtes concurrentes (JSON-RPC multiplexé) ; le créneau occupé donne
  `busy`, sans file applicative, selon le contrat existant.
- **Aucun egress, SQLite lecture seule, exception WAL étroite** : identiques dans
  les deux modes.
- Le mode stdio ne SHALL jamais être décrit comme « non sécurisé » ni comme un
  contournement : il supprime une surface (le port) plutôt que d'en ajouter une.

## D5 — Effets sur les contrats existants

Tous les contrats métier sont **transport-agnostiques** et conservés à
l'identique :

- **Curseurs** : le cache de curseurs est **process-local** (déjà le cas). En
  stdio, il meurt avec le processus client. Conséquence documentée : un curseur
  obtenu d'un processus précédent est refusé (`invalid_cursor`) après
  redémarrage du client, **jamais** traité comme une nouvelle requête (la
  sémantique `invalid_cursor` existante s'applique). Aucun cache persistant n'est
  introduit.
- **Fraîcheur / génération / vue indisponible** : inchangées ; les décisions de
  publication et de divergence restent celles du protocole existant
  (`view_unavailable`, `stale_cursor`).
- **Codes d'erreur fermés** : inchangés (`unknown_session`, `invalid_anchor`,
  `invalid_cursor`, `stale_cursor`, `invalid_params`, `view_unavailable`,
  `forbidden_host`, `busy`, `internal`). En stdio, `forbidden_host` n'est jamais
  produit puisqu'aucun en-tête n'est examiné.
- **Budget d'enveloppe (524 288 octets) et bornes de volume** : inchangés,
  mesurés sur stdout en stdio.
- **Catalogue et descriptions d'outils** : inchangés ; le transport ne change ni
  les outils ni leurs paramètres.

## D6 — Compatibilité rétroactive et configuration cliente

- `sdig mcp` sans flag : **comportement HTTP strictement inchangé**, y compris le
  message d'écoute, l'emplacement du jeton, les erreurs de démarrage et l'arrêt.
- Aucune option existante n'est supprimée, renommée ou changée de défaut.
- **Configuration cliente type** (à documenter au moment de l'implémentation
  autorisée, pas ici) :

```json
{
  "mcpServers": {
    "sdig": { "command": "sdig", "args": ["mcp", "--stdio"] }
  }
}
```

- La documentation produit SHALL préciser que le mode stdio est lancé par le
  client, que stdout est le canal protocole, que les journaux vont sur stderr et
  qu'aucun port n'est ouvert.

## D7 — Tests envisagés (implémentation future, aucun test écrit ici)

Tests **synthétiques décisifs**, sans donnée réelle ni jeu gelé :

- **Client officiel SDK sur stdio** : démarrer `sdig mcp --stdio` en **spawn
  réel** (processus enfant, pipes), connecter un client `@modelcontextprotocol/sdk`
  via `StdioClientTransport`, faire `tools/list` puis un appel `sdig_search` /
  `sdig_read` / `sdig_status` réussi.
- **stdout propre** : capturer stdout du processus enfant et vérifier qu'il ne
  contient **que** des trames JSON-RPC MCP valides (aucune ligne de journal, aucun
  texte d'aide) ; vérifier que les journaux attendus apparaissent sur stderr.
- **Aucun port lié** : vérifier qu'aucun socket TCP n'est ouvert par le processus
  en mode stdio.
- **Arrêt** : fermer stdin du client (EOF) et vérifier la terminaison du serveur ;
  envoyer `SIGTERM` et vérifier l'arrêt propre (attente du travail actif, purge du
  cache) ; vérifier qu'aucun processus détaché ne survit.
- **Curseur process-local** : obtenir un curseur, tuer le serveur, relancer un
  nouveau processus et vérifier que l'ancien curseur donne `invalid_cursor`.
- **Combinaison refusée** : `--stdio` combiné à une option de mode/HTTP invalide
  (et `--stdio` dupliqué) → refus au démarrage, sans écho de l'argument.
- **Non-régression HTTP** : la suite MCP existante (transport HTTP) doit rester
  verte ; le défaut sans flag ne change pas.
- **Budget** : vérifier que l'enveloppe sérialisée respecte 524 288 octets sur le
  canal stdio comme sur HTTP.

Validation locale d'implémentation future : suite MCP ciblée + `openspec validate
--specs --changes --strict --no-interactive` + `git diff --check`, comme pour les
changes précédents. La validation PC/banc sur corpus réel et l'archivage restent
des étapes distinctes (phase 3 des tâches).

## D8 — Décisions prises et options rejetées

**Prises :**

1. Ajouter un mode stdio additif à `sdig mcp`, **défaut HTTP inchangé**, plutôt
   que remplacer le transport existant.
2. Faire du stdio un **processus enfant du client** (durée de vie liée), conforme
   au principe « aucun travail détaché ».
3. Réserver stdout au protocole et envoyer **tous** les diagnostics sur stderr ;
   traiter toute pollution stdout comme un défaut à tester.
4. Conserver en stdio l'admission mono-travail et les contrats existants
   (curseurs, fraîcheur, erreurs fermées, budget), sans en dupliquer la logique.
5. Trancher côté principal que le stdio est **plus confiné** (aucun port), donc
   que l'absence de Host/Origin/jeton est acceptable et ne réduit pas les
   garanties de sécurité utiles.
6. Modifier la spec consolidée directement (post-archivage) via **deux MODIFIED**
   (« Architecture et transport », superset ; « Concurrence mono-travail et durée
   honnête », phrase d'arrêt/reprise bornée au mode HTTP — sans ce portage, la
   spec consolidée porterait deux énoncés contradictoires après archivage, revue
   du 06/10) et **un ADDED** dédié (« Transport stdio »).

**Rejetées / non retenues à ce stade :**

- **Service systemd / autostart / supervision / manifeste Termux** : rejeté — ça
  ne supprime pas le besoin d'ordre de démarrage ni la configuration par URL, et
  ça ajoute une gestion de processus de fond que le stdio évite. Reste une
  décision propriétaire distincte.
- **Extension pi ou wrapper du même genre** : rejeté — dépendance à un runtime
  tiers pour un besoin que le client MCP couvre nativement en stdio.
- **Double transport simultané** (HTTP et stdio dans le même processus) : rejeté
  — complexité, surface réseau conservée, bénéfice nul ; un seul mode par
  processus.
- **Remplacement / suppression du HTTP** : rejeté — casse la rétrocompatibilité et
  le besoin d'accès loopback multi-clients ; le HTTP reste le défaut.
- **Écrire la configuration cliente à la place de l'utilisateur** : rejeté — cette
  spec documente, elle n'installe ni ne modifie la configuration d'un client.
- **Rendre les curseurs persistants pour survivre à un redémarrage de client** :
  rejeté — élargirait le contrat des curseurs (durée de vie, borne mémoire) pour
  un besoin non démontré ; la sémantique `invalid_cursor` existante suffit.
- **Rendre le jeton obligatoire en stdio** : rejeté — il n'y a pas de requête HTTP
  à authentifier ; l'imposer ajouterait une friction sans gain de sécurité.

## D9 — Risques et points de vigilance

- **Pollution de stdout** : le risque principal. Toute dépendance, tout
  avertissement Node, tout `console.log` d'aide atteignable en stdio peut
  corrompre le flux. Mitigation : recensement exhaustif à l'implémentation,
  redirection de `--help` sur stderr, test « stdout propre ».
- **Comportement du SDK stdio** : la version épinglée `@modelcontextprotocol/sdk`
  1.31.0 fournit `StdioServerTransport` ; les détails de fermeture (`onclose`,
  erreurs de parsing) devront être vérifiés et testés, pas supposés. La borne de
  tampon de lecture du SDK est **10 Mio par défaut** (40× la borne de corps HTTP,
  256 Kio) : le change exige une borne **explicitement consignée** à
  l'implémentation (défaut épinglé ou valeur inférieure), et le dépassement
  constitue un **quatrième chemin d'arrêt** (erreur → fermeture du transport) à
  tester. La terminaison sur EOF repose sur la boucle d'événements (le SDK
  n'écoute pas `end`) : aucun handle keep-alive ne SHALL être introduit en stdio.
- **Course à l'arrêt** : l'arrêt sur EOF ou SIGTERM ne doit ni couper une réponse
  en cours de façon incohérente, ni laisser un travail détaché. Le chemin d'arrêt
  existant (`waitIdle`) est la référence ; les tests doivent le couvrir en stdio.
- **Confusion de documentation** : deux modes coexistent ; la documentation doit
  rendre explicite lequel ouvre un port et lequel n'en ouvre aucun, et que le
  défaut reste HTTP.
- **Faux sentiment de sécurité** : l'absence de Host/Origin/jeton en stdio ne doit
  pas être présentée comme une dégradation ni comme une authentification ; c'est
  une surface réseau en moins.
- **Aucun risque de fuite nouveau** : pas d'egress, SQLite lecture seule, journaux
  inchangés ; le budget de réponse reste borné.
