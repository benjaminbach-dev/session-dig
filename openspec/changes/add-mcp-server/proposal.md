# Change add-mcp-server

## Pourquoi

Le premier passage réel du jeu naturel (18-19/09) a montré que **la valeur est dans l'outil, pas dans le modèle** : avec `sdig`, le modèle testé retrouve la bonne session 50 fois sur 50 ; sans accès à l'archive, il ne produit rien de spécifique. Aujourd'hui cet outil n'est accessible qu'en ligne de commande — un agent doit donc être lancé sur la machine (serveur `opencode serve`, harness d'examen maison) pour en profiter, et Agora doit passer par le bash.

La roadmap du projet prévoit depuis le 15/09 la v1 : **exposer `sdig` en serveur MCP lecture seule**, pour que les agents (Agora, opencode, harness d'évaluation) creusent l'historique eux-mêmes, sans détour par le shell. Le patron est éprouvé : `agora-scout` (14/09) expose un MCP Streamable HTTP sur loopback, intégré dans Agora, avec outils bornés et politique de confidentialité écrite ; `sdig` a en plus l'avantage d'être **purement local** : il ne fait aucun appel modèle, donc coût nul et aucune sortie de données par le service lui-même.

Le risque dominant n'est pas technique mais de **confidentialité et de bornes** : l'archive contient l'historique privé de l'utilisateur (chemins, décisions, et dans les sorties d'outils brutes des contenus non triés qui peuvent inclure des secrets), et le dépôt est public — d'où deux règles structurantes dans cette spec : le service est **loopback uniquement** et n'émet rien vers l'extérieur ; et les sorties d'outils brutes ne sont **pas exposées par défaut**.

## Quoi change

- **ADDED** — nouvelle capacité `mcp` (7 exigences) : architecture et transport (Streamable HTTP loopback, aucun egress, supervision par le manifeste) ; catalogue fermé de 4 outils avec bornes par outil ; sorties bornées **jamais silencieuses** (marqueurs + compteurs + paramètre pour élargir) ; ancrage temporel exposé avec la même sémantique que le CLI (`read --at`) ; concurrence et délais bornés avec erreurs structurées ; confidentialité (loopback, aucun egress, journaux sans contenu, `raw` désactivé par défaut, et la règle explicite que ce que le service retourne sera vu par le fournisseur du **modèle appelant**) ; fraîcheur, déterminisme et schéma stable.
- Aucun changement des specs existantes : `corpus`, `search` et `natural-eval` restent telles quelles ; le serveur est une **façade en lecture** au-dessus d'elles.
- Aucun code dans ce change : la spec est écrite d'abord (SDD), l'implémentation est un change séparé.

## Impact

- **Specs** : nouvelle capacité `mcp` ; les autres capacités ne bougent pas.
- **Code (à venir, hors de ce change)** : `src/mcp/server.js` + `src/mcp/tools.js` (réutilise `src/retriever/bm25.js`, `src/read.js`, `src/format.js`, `src/raw.js` — aucune logique de recherche dupliquée), dépendance MCP TypeScript officielle à épingler après vérification, tests de contrat (outils, bornes, marqueurs, erreurs, concurrence, confidentialité), et une entrée dans le manifeste Termux `~/.config/agora/servers.sh` (décision propriétaire requise, comme pour `agora-scout`).
- **Explicitement hors périmètre** : écriture (ingestion, indexation), exécution de commandes, accès fichier arbitraire, exposition réseau, multi-utilisateur, embeddings (v2), actions sur les sessions opencode, remplacement du CLI `sdig` (le serveur partage son code, il ne le remplace pas).
- **Ce que la spec protège** : les fichiers du jeu d'évaluation (`eval/natural/…`) ne sont pas exposables par construction (aucun outil de lecture de fichier), et le service ne peut pas être détourné en outil d'écriture ou de commande — c'est écrit comme exigences, pas comme intentions.
