# Design — update-natural-eval

## Audit des accès : pourquoi un script, pas une règle de prompt

La règle « sdig seul » a tenu pour sqlite (0/50) mais pas pour la lecture directe des fichiers du corpus (1/50, manquée par l'audit manuel). Un prompt ne se vérifie pas ; un scan regex sur les toolCalls enregistrés, oui. Décisions :

- Motifs épinglés dans le script (toute évolution = commit) : `sqlite`, `opencode.db`, `index.db`, `events.jsonl`, `sessions.jsonl`, chemin du répertoire corpus, `sdig ingest|refresh`. `sdig read/raw/search/status/index` restent légitimes.
- L'audit **liste** les faits (question, outil, extrait de commande) ; la **qualification** (déviation majeure vs listage borderline) reste humaine, écrite dans le rapport. On ne veut pas d'un juge automatique faux négatif, on veut une détection zéro-faux-positif.
- **Un filet, pas une porte** (retour du 20/09) : l'audit regex détecte a posteriori, il ne garantit pas l'exclusivité d'accès. Quand le harnais d'un futur test permet une restriction réelle (outils désactivés, wrapper n'exposant que sdig), elle prime ; l'audit reste obligatoire dans tous les cas.
- La sortie est du markdown annexable au rapport (local, gitignored).

## Granularité de notation : l'unité est le fait, pas la réponse

L'analyse du 19/09 montre un facteur 7 entre les deux barres (36 vs 5 pleines). Décision : l'unité de notation est **l'entrée d'`expect`** (bullet E1, E2, E3…) notée ✔/~/✖ ; le tableau par question est la donnée première, les buckets en sont une vue dérivée :

- pleine = tous les faits ✔ ;
- partielle = au moins un fait non-✔ avec au moins un fait restitué (✔ ou ~) ;
- échec = aucune restitution (ni ✔ ni ~) ;
- **aucun bucket intermédiaire** : la première version du rapport d'analyse du 19/09 avait introduit « quasi-pleine » et « faible », puis les a appliqués de façon incohérente (des ✔✔✖ classées quasi-pleines) — la leçon est codifiée ici : trois buckets (pleine, partielle, échec), la nuance vit dans le tableau.

Un désaccord inter-correcteurs se tranche par extraction du texte intégral du message source (lecture seule du corpus) — c'est l'arbitrage qui fait foi, pas la majorité.

## Fausses méta-affirmations : signal distinct

Trois réponses sur 50 ont affirmé que l'archive ne contenait pas ce qu'elle contient (n41, n43) ou avoir « confirmé » un contenu partiel (n17). C'est plus grave qu'un fait perdu : la réponse décrit faussement **la source**, ce qui disqualifie la confiance qu'un lecteur peut accorder au reste. D'où un taux propre dans le rapport, distinct du taux d'invention (une fausse absence n'est pas une invention : le fait est dans l'archive).

## Ancrage temporel

La vérité terrain d'une question d'état est le texte du message **répondant**, à l'instant de la question. Restituer un état postérieur (même session — config modifiée plus loin — ou session ultérieure) = dérive temporelle, comptée échec de fidélité, jamais invention. Le flag `volatile` existant couvre le jugement « contre l'archive, pas contre l'état actuel » ; l'adjudication intra-session est la généralisation naturelle. L'analyse a aussi montré des réponses qui datent correctement les états (n08, n45) : le phénomène est réel mais gérable, il doit juste être tranché.

## Inter-notation : périmètre minimal

Toutes les réponses non pleines + les écarts de procédure (questions jamais notées, récupérations `recovered`) + un échantillon de 5 réponses pleines. La relecture relit des réponses existantes : aucun re-passage du jeu, aucun coût modèle. L'analyse du 19/09 a joué ce rôle pour le premier passage (grille complète + arbitrages) ; la spec en fait une obligation pour les suivants.
