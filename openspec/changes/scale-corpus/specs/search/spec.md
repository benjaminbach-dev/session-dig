# Delta search — scale-corpus

## MODIFIED Requirements

### Requirement: Interface Retriever

Tout retriever SHALL implémenter une interface unique : `name`, `index(corpus)`, `search(query)` retournant une liste de hits `{eventId, score}`. Décision du 20/09 (change `scale-corpus`, contrainte d'échelle) : l'indexation opère **depuis le corpus en flux** (racine du corpus, ou itérateur borné fourni par le cœur) — l'interface ne permet plus de forcer le chargement complet du corpus en mémoire (l'ancienne signature `index(events)` sur tableau matérialisé est retirée). Tout retriever SHALL passer la suite contractuelle commune : (1) si un événement E est indexé, une requête composée de mots présents dans son texte doit retourner E ; (2) l'indexation est idempotente ; (3) l'index est entièrement reconstruisable depuis le seul corpus. Cette interface est la couture d'extension du projet : v0 n'active que le retriever `bm25`, mais aucune évolution ultérieure ne contournera l'interface.

#### Scenario: Contrat respecté

- **WHEN** un nouveau retriever est proposé
- **THEN** il passe la suite contractuelle commune avant toute intégration, sans exception ni test ad hoc.

#### Scenario: Index jetable

- **WHEN** l'index d'un retriever est supprimé
- **THEN** une réindexation depuis le seul corpus le reconstitue sans perte d'information permanente.

#### Scenario: Indexation en flux

- **WHEN** un corpus de plusieurs millions d'événements est indexé
- **THEN** l'indexation s'exécute en flux, sans matérialiser le corpus en mémoire, et produit le même index qu'une reconstruction complète depuis la même source.

### Requirement: Performance

L'indexation complète d'un corpus d'environ 5 000 messages SHOULD s'exécuter en quelques secondes ; une requête SHOULD répondre en moins de 100 ms à cette échelle. Décision du 20/09 (change `scale-corpus`, resserrée sur retour du soir) : ces bornes sont re-visées à l'échelle et vérifiées sur un **banc synthétique déterministe** commis dans le dépôt, hors `npm test`. Le banc mesure **le parcours utilisateur complet, pas la seule couche FTS5** : recherche avec rendu groupé par session et voisins (`--ctx`) ; lecture de session avec ancrage `--at` et compteurs exacts ; ingestion initiale et delta depuis une **base source synthétique reprenant la structure réelle d'opencode.db** (mêmes tables, mêmes colonnes) ; lecture de preuve volumineuse. Les conditions de mesure sont consignées : machine, cache chaud/froid (mesures répétées), RSS maximale, espace disque temporaire. Cibles de conception : recherche p95 < 100 ms sur 500 000 événements (parcours complet rendu) ; lecture `--at` avec compteurs p95 < 100 ms sur une session de 10 000 messages ; delta d'ingestion de 1 000 événements < 10 s sur un corpus d'un million d'événements ; reconstruction complète du banc < 5 minutes ; empreinte mémoire < 512 Mo pour toute opération du banc. Ces bornes restent des cibles de conception, pas des garanties contractuelles ; elles SHALL être vérifiées au banc au moment de l'implémentation et ajustées avec justification si la mesure les contredit.

#### Scenario: Volumétrie réelle

- **WHEN** le corpus réel (~5 000 messages) est indexé
- **THEN** la durée est mesurée et consignée dans le dépôt, et la requête type reste sous la cible.

#### Scenario: Banc synthétique à l'échelle

- **WHEN** le banc 100× est exécuté (recherche rendue, lecture `--at`, ingestion depuis la base synthétique, preuve volumineuse)
- **THEN** les mesures p50/p95, la RSS maximale et les conditions (machine, cache, disque) sont consignées dans le dépôt, et tout écart aux cibles est documenté et arbitré (cible ajustée avec justification, ou implémentation corrigée).

### Requirement: Recherche brute optionnelle

Les sorties d'outils restent exclues de l'index BM25 par défaut (décision du 15/09 : signal contre bruit). Le CLI SHALL offrir une recherche optionnelle par sous-chaîne dans `raw/` (`--raw`), car une erreur précise n'apparaît parfois que dans stderr. Cette recherche SHALL resituer chaque match (session, date, outil, commande) et rester bornée en résultats. Décision du 20/09 (change `scale-corpus`, resserrée sur retour du soir) : le scan s'exécute en **flux** — fichier par fichier, **par blocs bornés à l'intérieur de chaque fichier** (recouvrement aux frontières pour ne pas perdre un match à cheval) — et son coût O(volume de `raw/`) est documenté et annoncé : l'option reste opt-in, une opération consciente, jamais une surprise de durée ; l'empreinte mémoire ne dépend pas de la taille des fichiers.

#### Scenario: Erreur uniquement en stderr

- **WHEN** une requête avec `--raw` vise un message d'erreur absent des textes indexés
- **THEN** le match dans la sortie brute est listé avec sa session et sa commande, sans avoir été ajouté à l'index BM25.

#### Scenario: Scan en flux borné

- **WHEN** `--raw` est exécuté sur un `raw/` de plusieurs gigaoctets contenant des fichiers volumineux
- **THEN** le scan traite les fichiers par blocs sans charger l'archive ni les fichiers entiers, rend un résultat borné et affiche sa durée.
