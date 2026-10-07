# Change add-mcp-stdio

> **Change DOCUMENTAIRE — implémentation explicitement interdite à ce stade.**
> Décision du principal (2026-10-06) : le transport stdio est voulu, ce change
> doit être écrit, relu et corrigé ; **aucune ligne de code, aucun test, aucune
> modification de `src/`, de `docs/` ni de `openspec/specs/`**. Le delta vit dans
> `openspec/changes/add-mcp-stdio/specs/mcp/spec.md` et ne touche la spec
> consolidée qu'à l'archivage, après validation PC/banc (phase 3).

## Why

Le serveur MCP de session-dig impose aujourd'hui trois frictions constatées en usage réel : le serveur doit être lancé à la main **avant** la session cliente (ordre de démarrage), la connexion est **figée au démarrage** du client (URL/port), et la configuration cliente se fait **manuellement par URL**. Le 06/10/2026, le principal a décidé d'ajouter un mode **stdio** lancé par le client MCP lui-même, qui supprime ces trois frictions sans supprimer le mode HTTP. Le transport stdio avait été explicitement exclu par le change `add-mcp-server` (« aucun deuxième transport », YAGNI d'alors) ; ce change **lève cette exclusion sur besoin démontré**, pas par opportunité.

## What Changes

- **MODIFIED** — exigence `mcp` « Architecture et transport » : réécrite en **superset** (l'unique phrase réécrite est l'énoncé du transport — « avec Streamable HTTP » devient l'énoncé des deux modes ; aucune clause affaiblie). Le service SHALL offrir un mode **Streamable HTTP OU stdio** choisi au lancement ; **un seul mode actif par processus**, refus explicite des combinaisons invalides. En **stdio** : **AUCUN port écouté**, stdout réservé au protocole MCP, journaux **stderr uniquement**, arrêt propre conservé, mort du client = mort du serveur. En **HTTP** : tout le texte actuel reste (écoute exclusive `127.0.0.1:18767`, contrôles Host/Origin, jeton optionnel, aucun egress, SQLite RO, exception WAL étroite). L'exclusion « aucun deuxième transport » est levée explicitement ; le mode HTTP reste le défaut.
- **MODIFIED** — exigence `mcp` « Concurrence mono-travail et durée honnête » : phrase d'arrêt/reprise bornée au mode HTTP (**en stdio, la durée de vie est celle du client** — arrêt par le client, reprise par relance du client, jamais d'opérateur) ; scénario « Requête lente » précisé pour les deux modes ; aucune autre clause changée. Sans ce portage, la spec consolidée porterait deux énoncés contradictoires après archivage (revue du 06/10). - **ADDED** — exigence « Transport stdio » : même catalogue, mêmes handlers, mêmes validations des arguments d'outils et codes fermés, même budget d'enveloppe et mêmes contrats de réponse qu'en HTTP ; stdout réservé EXCLUSIVEMENT au protocole ; aucun socket ; tampon de lecture stdin **borné explicitement** (trame dépassant la borne = quatrième chemin d'arrêt) ; lancement par le client (spawn), durée de vie liée au client, mort du client = arrêt sans travail détaché ; admission mono-travail conservée ; cache de curseurs process-local, curseur d'un processus précédent refusé (`invalid_cursor`).
- **Commande visée** : `sdig mcp --stdio` (flag **additif**). Le mode par défaut sans flag reste **HTTP** (rétrocompatibilité stricte) ; les surcharges `--home/--db/--pi-dir` restent communes et inchangées.

## Contexte d'usage (constat du 06/10/2026)

- Le lancement HTTP est **manuel** (`sdig mcp`) et doit précéder la session cliente : mauvais ordre = client qui échoue à se connecter.
- La configuration cliente est une **URL** (`http://127.0.0.1:18767/mcp`), recopiée à la main, donc sujette à erreur et à dérive.
- Le serveur HTTP est un processus **de fond** à gérer (démarrage, arrêt, supervision) alors que le besoin réel est un **processus enfant du client**, démarré et arrêté avec lui.
- Ces frictions sont des **coûts d'adoption** mesurés en usage, pas des défauts de sécurité : le stdio n'ouvre aucun port et n'affaiblit aucune garantie (voir design).

## Portée (minimale)

- Un **unique mode stdio** sur la commande existante `sdig mcp`, activé par `--stdio`.
- Le mode HTTP existant, ses garde-fous, ses contrats et son **statut de défaut** sont **inchangés**.
- Aucune modification des handlers métier, du catalogue d'outils, des schémas, des bornes, des codes d'erreur, du budget de réponse, de la fraîcheur, du cache de curseurs côté logique.
- Documentation produit minimale (lancement `sdig mcp --stdio`, configuration cliente type) au moment de l'implémentation autorisée.

## Non-goals

- **Aucun autostart, aucun service systemd, aucune supervision, aucun manifeste Termux** : ces extensions restent des décisions propriétaires distinctes, reportées, hors de ce change.
- **Aucun nouvel outil MCP**, aucun `sdig_raw`, aucune ressource/prompt, aucun paramètre métier nouveau.
- **Aucune suppression ni dépréciation du transport HTTP** ; il reste disponible et par défaut.
- **Aucun double transport simultané** dans un même processus.
- **Aucun changement des handlers** (`search`/`read`/`status`), de leurs contrats ni de leur sémantique.
- **Aucune installation automatique** ni écriture de configuration cliente à la place de l'utilisateur.
- **Aucun travail de fond détaché** : la mort du client termine le serveur.

## Position vis-à-vis de la spec consolidée

- `add-mcp-server` et `add-mcp-chrono` sont **archivés** (06/10/2026). Il n'existe plus de change actif : le delta **MODIFIE la spec consolidée** `openspec/specs/mcp/spec.md` (SDD post-archivage), et non un autre delta.
- Le **MODIFIED** reprend le **texte complet** de « Architecture et transport » en superset : toutes les phrases normatives actuelles sont conservées, l'exclusion « aucun deuxième transport » est remplacée, et les contraintes stdio sont ajoutées.
- Le **ADDED** « Transport stdio » porte les garanties propres au mode, pour ne pas gonfler l'exigence d'architecture au-delà de ce qui est transport-agnostique.
- **Ordre d'archivage** : ce change n'a aucune dépendance à un change actif ; il modifie directement l'exigence consolidée, qui existe déjà.

## Impact

- **Documentation seulement à ce stade** : `proposal.md`, `design.md`, `tasks.md`, delta `specs/mcp/spec.md` (deux `MODIFIED`, un `ADDED`). Aucun code, aucun test, aucune modification de `openspec/specs/` ni de `docs/`.
- **Implémentation future (interdite ici)** : séparation transport/handlers déjà en place (`createApp` injecte les handlers ; le transport vit dans `src/mcp/server.js`), ajout d'un chemin stdio branché sur le même cœur, flag `--stdio` dans le parser dédié `sdig mcp`, documentation `docs/mcp.md`. Détail et tests envisagés dans `design.md`.
- **Hors périmètre** : autostart/supervision, outils nouveaux, raw, suppression du HTTP, changement de handler, concurrence >1, timeout applicatif garanti, offsets de curseurs persistants.
- **Confidentialité** : inchangée (archive locale, lecture seule, aucun egress) ; la journalisation reste sur stderr, à champs et valeurs épinglés. En stdio, stdout ne porte que le protocole.
