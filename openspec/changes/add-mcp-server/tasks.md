# Tâches — add-mcp-server

Phase spec (ce change) :

- [x] Écrire la spec de la capacité `mcp` (7 exigences, scénarios) — proposée, design et delta ci-joints.
- [x] Décisions consignées dans `design.md` : transport et port (loopback exclusif), catalogue fermé de 4 outils, plafonds durs + marqueurs de troncature, réutilisation de la sémantique `read --at`, `raw` désactivé par défaut, concurrence 2 / délai 5 s / erreurs structurées, fraîcheur et déterminisme, journaux sans contenu.
- [ ] Validation stricte du change (`openspec validate --specs --changes --strict`) et commit de la spec **avant** tout code.

Phase implémentation (change séparé, à ouvrir ensuite) :

- [ ] Vérifier la version publiée du SDK MCP TypeScript officiel (ligne v1 vs v2), l'épingler dans `package.json`, et confirmer le transport Streamable HTTP avec la version retenue.
- [ ] `src/mcp/tools.js` : les 4 outils comme **façade** au-dessus de `src/retriever/bm25.js`, `src/read.js`, `src/format.js`, `src/raw.js` (aucune logique de recherche dupliquée) ; bornes de `design.md` appliquées côté serveur ; objet `truncated` avec compteurs exacts ; `freshness` ; codes d'erreur stables.
- [ ] `src/mcp/server.js` : écoute `127.0.0.1:18767` (refus explicite de toute autre interface), token statique optionnel, concurrence 2 + statut `busy`, délai 5 s avec résultat partiel, ouvertures lecture seule, journaux de métadonnées sans contenu, arrêt propre.
- [ ] `sdig_raw` : absent du catalogue par défaut ; activation par configuration (`expose_raw`), activation journalisée, réponses marquées `unvetted` et bornées.
- [ ] Tests de contrat (fixture synthétique) : présence/absence des outils selon configuration, bornes ramenées et signalées, marqueurs de troncature (dont budget de réponse), ancrage temporel identique au CLI (dont ancre vide/inexistante/invalide), erreurs structurées sans contenu d'archive, saturation → `busy`, délai → partiel, fraîcheur et rejeu identique.
- [ ] Test d'intégration avec un client MCP réel (le patron `agora-scout` sert de référence) : initialisation, appel de chaque outil, réponse bornée, reconnexion.
- [ ] Vérification de confinement : le service refuse une configuration non-loopback ; aucun appel réseau sortant (vérification explicite) ; aucune écriture dans le corpus (md5 avant/après).
- [ ] Documentation : `README.md` (section « serveur MCP » : lancement manuel, outils, bornes, confidentialité) et `openspec/implementation-plan.md` (phase v1 livrée).
- [ ] Ajout au manifeste Termux `~/.config/agora/servers.sh` — **décision propriétaire explicite** (comme pour `agora-scout`), hors de ce change.
