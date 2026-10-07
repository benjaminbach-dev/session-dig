# Tâches — add-mcp-stdio

> **Change documentaire.** Décision du principal (2026-10-06) : le transport
> stdio est voulu ; le change doit être écrit, relu et corrigé. **Aucune
> implémentation à ce stade.** La phase 1 (rédaction) peut être cochée après
> validation OpenSpec et relecture ; la phase 2 (implémentation) est
> **entièrement décochée** et interdite tant que le principal ne l'a pas
> autorisée explicitement.

## 1. Phase rédaction (documentaire — ce change uniquement)

- [x] 1.1 Rédiger `proposal.md` : constat d'usage du 06/10/2026 (lancement manuel, ordre de démarrage, connexion figée au démarrage du client, config par URL), portée minimale (un mode stdio sur `sdig mcp`, rien d'autre), non-goals (pas d'autostart/systemd/supervision, pas de nouvel outil, pas de raw, pas de suppression du HTTP, pas de changement des handlers), position vis-à-vis de la spec consolidée (delta `MODIFIED` + `ADDED`), levée explicite de l'exclusion historique « aucun deuxième transport ».
- [x] 1.2 Rédiger `design.md` : sélection du transport (défaut HTTP inchangé, flag additif `--stdio`, un seul mode par processus), cycle de vie (spawn/arrêt par le client, mort du client = mort du serveur, aucun travail détaché), journalisation (stdout protocole SEULEMENT, stderr journaux, recensement des écritures stdout à vérifier), garde-fous (pas de Host/Origin/jeton en stdio, justification par l'absence de socket), admission, curseurs process-local, fraîcheur/erreurs/budget inchangés, compat rétro, config cliente type, tests envisagés, décisions et options rejetées, risques.
- [x] 1.3 Écrire le delta `specs/mcp/spec.md` : `## MODIFIED Requirements` pour « Architecture et transport » (texte complet en superset, phrases normatives actuelles conservées, exclusion « aucun deuxième transport » remplacée, contraintes stdio ajoutées : aucun port, stdout protocole, stderr journaux, un mode par processus, refus des combinaisons invalides) et pour « Concurrence mono-travail et durée honnête » (phrase d'arrêt/reprise bornée au mode HTTP, scénario « Requête lente » précisé — portage exigé par la revue du 06/10 pour éviter une contradiction consolidée), et `## ADDED Requirements` « Transport stdio » (mêmes contrats, tampon stdin borné explicitement = quatrième chemin d'arrêt, arrêt propre, mort du client = mort du serveur, admission mono-travail, curseur process-local refusé après redémarrage, scénarios décisifs).
- [x] 1.4 Rédiger ces tâches (phase rédaction cochée, phase implémentation décochée et interdite, phase archivage ouverte).
- [x] 1.5 Validation OpenSpec stricte : `openspec validate add-mcp-stdio --strict --no-interactive`, puis `openspec validate --specs --changes --strict --no-interactive`, et `git diff --check` propre ; `git status` ne montre QUE `openspec/changes/add-mcp-stdio/`.
- [x] 1.6 Relecture du principal sur les quatre artefacts (cohérence, superset des deux `MODIFIED`, non-goals, décisions tranchées) et corrections éventuelles. **Faite le 06/10/2026** : corrections grammaticales, puis revue Advisor intégrée (contradiction consolidée « arrêt et reprise manuels » → second `MODIFIED` ; borne du tampon stdin = quatrième chemin d'arrêt ; jeton bien formé vs malformé ; validation protocolaire vs arguments d'outils ; nuance budget `\n`). Commit/push documentaire confié au principal sur autorisation explicite ; cette livraison **n'autorise aucun début d'implémentation implicite**.

## 2. Phase implémentation

> **`Implémentation interdite tant que le principal ne l'a pas autorisée — ce
> change n'autorise aucun début d'implémentation implicite.`** Les cases
> ci-dessous sont **décochées** et le resteront tant que l'autorisation explicite
> du principal n'aura pas été donnée. Aucun test, aucune ligne de code, aucune
> modification de `src/`, `docs/` ou `openspec/specs/` avant cette autorisation.

- [ ] 2.1 Épingler avec le principal le périmètre exact d'implémentation : flag `--stdio` additif, défaut HTTP inchangé, un seul mode par processus, refus explicite des combinaisons invalides et de `--stdio` dupliqué, aucun port lié, stdout protocole seul.
- [ ] 2.2 Ajouter le mode stdio dans `src/mcp/server.js` (ou un module transport dédié) en réutilisant le **même cœur** (handlers, validators, admission, codes d'erreur, budget) que le transport HTTP ; connecter un `StdioServerTransport` du SDK épinglé `@modelcontextprotocol/sdk` 1.31.0 ; lier la durée de vie à stdin/au processus client.
- [ ] 2.3 Brancher `--stdio` dans le parser dédié `sdig mcp` (`bin/sdig.js`) : admis avec `--home/--db/--pi-dir`, incompatible avec toute option de connexion HTTP, refus sans écho de tout flag inconnu ou dupliqué ; décider le sort de `--help` en stdio (aide sur stderr, jamais sur stdout).
- [ ] 2.4 **Recenser toutes les écritures stdout atteignables en mode stdio** (`console.log`, aides, avertissements de dépendances, sorties Node/npm) et garantir qu'aucune ne fuit ; rediriger l'aide sur stderr en stdio ; vérifier que la journalisation de production reste `stderr` uniquement.
- [ ] 2.5 Conserver l'arrêt propre : SIGINT/SIGTERM → attente du travail actif + purge du cache (`dispose`) ; mort du client / EOF stdin → terminaison sans travail détaché ; vérifier l'absence de course à l'arrêt.
- [ ] 2.6 Conserver l'admission mono-travail et la sémantique des curseurs process-local : un curseur d'un processus précédent donne `invalid_cursor`, jamais une nouvelle requête ; aucun cache persistant ajouté.
- [ ] 2.7 Non-régression HTTP : `sdig mcp` sans flag strictement inchangé (écoute, jeton, erreurs de démarrage, arrêt) ; suite MCP existante verte.
- [ ] 2.8 Tests synthétiques décisifs : client officiel SDK sur stdio en **spawn réel** (`StdioClientTransport`), `tools/list` + appels réussis ; stdout ne porte que des trames MCP ; journaux attendus sur stderr ; aucun socket TCP ouvert ; EOF/stdin et SIGTERM ; **trame stdin dépassant la borne du tampon → fermeture du transport (quatrième chemin d'arrêt)** ; curseur après redémarrage → `invalid_cursor` ; combinaison de modes refusée ; budget 524 288 octets respecté sur le canal stdio (cas limite exactement à budget, cadrage `\n` compris).
- [ ] 2.9 Mettre à jour `docs/mcp.md` (lancement `sdig mcp --stdio`, configuration cliente type, stdout protocole, journaux stderr, aucun port, défaut HTTP inchangé) et, si pertinent, l'usage de `sdig mcp --help`.
- [ ] 2.10 Validation finale d'implémentation LOCALE : suite MCP ciblée + `openspec validate --specs --changes --strict --no-interactive` + `git diff --check`, sans donnée réelle ni jeu gelé dans le dépôt. **Aucune validation PC ni banc réel.**

## 3. Revue, validation réelle et archivage

- [ ] 3.1 Relecture du principal sur l'implémentation (diff relu) et validation LOCALE reproduite.
- [ ] 3.2 Validation ciblée PC / client MCP sur corpus réel après lancement `sdig mcp --stdio` : `tools/list`, appels search/read/status, stdout propre, journaux stderr, arrêt par fermeture du client, refusal des combinaisons invalides, non-régression HTTP. Résultat consigné dans un fichier de validation dédié au change.
- [ ] 3.3 Archivage du change et application du delta à `openspec/specs/mcp/spec.md` ; décision de clôture du principal. Aucune dépendance d'ordre d'archivage (aucun change actif).
