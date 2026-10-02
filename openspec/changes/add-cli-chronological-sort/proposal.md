# Change add-cli-chronological-sort

## Pourquoi

La recherche `sdig` classe aujourd'hui les résultats par pertinence BM25 : elle répond « quel message ressemble le plus à cette requête », pas « quelle est la première trace de X » sur l'ensemble du corpus fusionné. Prouver un « premier usage » ou un « premier message » demande actuellement du SQL ou une lecture manuelle, et le tri BM25 ne peut pas garantir que l'événement le plus ancien figure dans son top-k. Le besoin exprimé est de prévoir un tri chronologique global et ses premiers usages (`--sort oldest|newest`) sans dégrader le tri de pertinence existant.

## Quoi change

- **ADDED** — option CLI `--sort relevance|oldest|newest` : **option omise = `relevance` strictement inchangé**, **option présente sans valeur** (ex. `--sort --limit 1`) ou valeur inconnue = erreur de valeur (sans consommer l'option suivante) ; `oldest`/`newest` sélectionnent l'ENSEMBLE des matches filtrés puis ordonnent par `(ts, id)` avant `--limit`, et non un top-k BM25 réutilisé.
- **ADDED** — mode chronologique sans mots-clés : requête optionnelle **physiquement** (requête fournie vide/espaces/stopwords seuls suit la normalisation existante, jamais une bascule silencieuse) ; sous-ensemble canonique = intersection `role ∈ {user, assistant}` ∩ `--role` (`--role title` ou inconnu → zéro hit) ; événements à texte vide ou commandes seules inclus ; `model: null` explicite et avertissement conditionnel sur `stderr` en JSON.
- **MODIFIED** — exigence « CLI sdig » : usage et aide enrichis, refus explicites (`--sort` sans valeur/inconnu/hors recherche — dont `mcp` sur message fixe sans recopie, `relevance` sans requête), compatibilité conservée des lignes de titre en mode avec mots-clés, `--source`/`read`/option inconnue inchangés.
- **ADDED** — portée et honnêteté du tri : pas de sous-commande (aucune « sessions ») ni d'outil MCP nouveau, `--raw` + chrono refusé, `--at` et `--after`/`--before` inchangés, aucune mutation implicite, vue courante réutilisée, `--limit` = troncature (pas d'exhaustivité, pas de curseur), minimum du sous-ensemble canonique de l'archive courante, distinction premiers messages / premières sessions ; `--source` filtre la provenance archivée (une source archivée absente du disque reste cherchable).
- **ADDED** — affichage et métadonnées : ordre global préservé à l'écran (rendu plat par hit si nécessaire), JSON en tableau compatible, `score` numérique en `relevance` et en chrono **avec** mots-clés (diagnostic constant), `null` seulement en chrono **sans** mots-clés (nouveau mode, pas un élargissement de type du défaut), voisins `--ctx` jamais candidats et jamais ajoutés au JSON.
- **Hors périmètre** : listes globales de sessions, identification de la « première session » (distincte du premier message), embeddings/RRF, index de source supplémentaire, modification du scoring BM25 ou de l'API/curseur MCP.

> **État au 02/10/2026** : ces changements sont désormais **implémentés localement** (fixtures synthétiques ; `tasks.md` phase 2). **Aucune validation PC, aucun archivage**, jeu naturel gelé non rejoué.

## Impact

- **Specs** : delta `search` uniquement — exigence « CLI sdig » modifiée (texte complet, superset du delta actif `add-pi-adapter` pour `--source`/provenance) et quatre exigences chronologiques ajoutées. Aucun delta `corpus` ; les exigences `scale-corpus` (Interface Retriever, Performance, Recherche brute) ne sont pas touchées.
- **Code (futur, non implémenté ici)** : `bin/sdig.js` (option, validation, choix du chemin chronologique), requête de vue `(ts, id)` exposée par `src/retriever/bm25.js` ou un helper du retriever, `src/format.js` (rendu préservant l'ordre global, `score` nullable), `src/read.js` pour `--ctx` inchangé.
- **Non-régression** : mode `relevance` (défaut), `--raw` par défaut et façade/curseur MCP inchangés ; les requêtes dorées et le harnais `npm run eval` ne bougent pas. Aucune donnée réelle ni réplique évaluation gelée n'entre dans ce change.
- **Coût assumé** : la sélection chronologique peut scanner tous les matches filtrés côté SQL ; c'est un coût documenté, sans garantie de réponse sous 100 ms. Le chargement JS reste borné aux résultats + contexte.
- **Confidentialité** : inchangée (corpus local, aucun secret, fixtures synthétiques seulement).
