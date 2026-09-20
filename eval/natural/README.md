# Évaluation naturelle — questions réelles tenues à l'écart

Ce dossier contient un jeu de test **privé** : des questions réellement posées par l'utilisateur,
tirées au hasard dans le corpus, avec la vérité terrain issue de la réponse réellement donnée
dans la session. Il sert à mesurer si un agent, dans une session neuve, sait **retrouver et
restituer** l'historique réel — et non ce qu'un modèle sait du monde.

La méthode fait foi : `openspec/specs/natural-eval/spec.md`. À lire avant toute exécution.

## ⚠️ Confidentialité

Les fichiers de données de ce dossier contiennent des extraits de l'historique privé
(chemins, projets, décisions). Le dépôt du projet est **public** : ces fichiers sont ignorés par
Git et ne doivent jamais être committés, publiés, ni collés dans une conversation partagée.
Seuls `README.md` (ce fichier), la spécification de méthode et les scripts génériques sont suivis.

## Contenu du dossier

| Fichier | Suivi par Git | Rôle |
|---|---|---|
| `README.md` | oui | ce fichier (méthode et mode d'emploi) |
| `curated.json` | non | curation humaine : faits attendus, étiquettes, notes (source) |
| `questions.jsonl` | non | jeu de test final (une question par ligne, avec vérité terrain) |
| `questions.md` | non | le même jeu, lisible par un humain |
| `candidates.jsonl` | non | tous les candidats après filtres automatiques |
| `sample.jsonl` / `sample-review.md` | non | tirage revu (`sample.jsonl` porte les identifiants `qNNN`) |
| `runs/` | non | rapports d'exécution, un fichier par passage |

## Régénérer le jeu

```bash
node scripts/natural-extract.mjs --n 110 --cap 30 --seed 20260918   # tirage déterministe
#   → revue humaine : sample-review.md → curation → curated.json
node scripts/natural-build.mjs                                      # vérifie contre le corpus et écrit le jeu
```

`natural-build.mjs` échoue bruyamment si une question citée n'existe plus dans le corpus
ou si la curation est incomplète : un jeu partiel ne doit jamais passer inaperçu.

## Passer le test à un agent

```bash
node scripts/natural-list.mjs --md --seed 42 > /tmp/passation.md   # questions SEULES
```

L'export de passation ne contient que les identifiants et les questions : ni faits attendus,
ni session source. L'agent testé doit tourner dans une **session neuve** sans historique, et ne
doit pas pouvoir lire les fichiers de vérité terrain (`questions.jsonl`, `questions.md`,
`curated.json`, `runs/`) — une exécution où cela arrive est invalide, pas ratée.

Deux variantes, toujours annoncées dans le rapport :

- **A — avec archive** (mesure principale) : l'agent accède au corpus en lecture seule via `sdig`
  et doit citer la ou les sessions utilisées ;
- **B — sans archive** (témoin) : aucun accès au corpus ; mesure la part non discriminante du jeu.

## Noter

Deux axes séparés, parce qu'ils échouent séparément :

1. **rappel** — la session source est-elle citée (identifiant complet, titre sans ambiguïté, ou
   identifiant tronqué si l'identifiant complet figure ailleurs dans la même réponse) ? En variante A,
   une réponse juste mais non sourcée n'a pas fait le travail demandé : rappel nul ;
2. **fidélité** — les faits attendus sont-ils présents et corrects, sans affirmation interdite
   (`mustNot`) ni fait inventé ? L'abstention honnête passe avant l'invention : une abstention est un
   échec de rappel, une invention est un échec de fidélité *et* un signal de fiabilité négatif.

**Unité de notation = le fait attendu.** Chaque entrée d'`expect` reçoit ✔ (restitué), ~ (partiel) ou
✖ (absent) ; le **tableau par question** (rappel + une colonne par fait) est la donnée première du
rapport, les listes agrégées n'en sont qu'une vue. Buckets, sans label intermédiaire :

| Bucket | Définition |
|---|---|
| **pleine** | tous les faits ✔ |
| **partielle** | au moins un fait non-✔ **et** au moins un fait restitué (✔ ou ~) |
| **échec** | aucune restitution (ni ✔ ni ~) |

« quasi-pleine », « faible » et autres nuances ne sont **pas** des buckets : la restitution partielle
se lit dans le tableau, pas dans un label (l'expérience du 19/09 a montré que les labels dérivent).
Rapporter les scores par étiquette de spécificité (`high` seul, puis `high`+`medium`, puis ensemble) —
un score global qui mélange culture générale et archive ne dit rien.

Deux signaux propres, comptés à part des buckets :

- **fausses méta-affirmations** — « l'archive n'en conserve pas davantage », « non récupérable »,
  « confirme le contenu ci-dessus », alors que le texte intégral existe (extraction à l'appui) : le
  fait est ✖, l'affirmation est tracée et agrégée en taux propre. Plus grave qu'un détail perdu (elle
  décrit faussement la source), ce n'est pas une invention ;
- **dérives temporelles** — une question d'état se répond **à l'instant où elle a été posée** :
  restituer un état postérieur (mutation plus tard dans la session, ou session plus récente) est un
  échec de fidélité temporel, documenté comme tel, jamais compté comme invention.

Une question qui oriente une décision d'implémentation sort du jeu (voir Règle d'or ci-dessous). Un
écart documenté (question légitimement ambiguë, réponse devenue fausse depuis) est consigné et exclu
de l'agrégat, jamais compté comme échec silencieux.

## Auditer les accès (obligatoire en variante A)

La variante A n'accède à l'archive que via `sdig`. Le dépôt embarque le filet de détection :

```bash
node scripts/audit-toolcalls.mjs <dossier-de-run>            # markdown, à annexer au rapport
node scripts/audit-toolcalls.mjs <dossier> --strict          # exit 1 si déviation détectée
node scripts/audit-toolcalls.mjs <dossier> --out audit.md    # écrit le rapport d'audit
node scripts/audit-toolcalls.mjs --motifs                    # liste les motifs épinglés
```

Ce que l'audit regarde — **la commande réellement invoquée, jamais la simple présence d'un mot** :

- chaque segment (pipeline, `&&`, `;`) est découpé en commande, arguments et redirections ; quand
  cette commande est `sdig`, seules une sous-commande mutante (`ingest`, `refresh`) ou une
  redirection/argument pointant un fichier de l'archive sont des déviations. D'où :
  `sdig search "ingest"` = recherche légitime, `sdig ingest` = écriture, `grep sdig events.jsonl` =
  lecture directe, `sdig read ses_x < events.jsonl` = lecture par redirection ;
- les invocations sdig légitimes (`search`, `read`, `raw`, `status`, `index`) sont exemptées, sauf
  leurs redirections et les chemins passés en argument positionnel ;
- les **formes indécidables** (commande dynamique, `$(…)`, `xargs`, `eval`, option pointant un
  chemin explicite) sont listées **« à examiner »** : ni déclarées propres, ni accusées — à trancher
  à la main dans le rapport ;
- la lecture des fichiers du jeu de test est listée comme **invalidante** (exécution exclue de
  l'agrégat, pas notée).

Ce que l'audit fait d'une entrée qu'il ne sait pas lire : il ne la compte **pas** comme propre. Un
JSON illisible ou un appel dont la commande n'est pas extractible est compté, listé, et fait basculer
le rapport en **« audit incomplet »** (sortie non nulle en `--strict`). « Aucune déviation détectée »
ne se dit que d'un **audit complet**.

Les motifs sont épinglés dans le script et leur empreinte figure dans l'audit : toute évolution passe
par un commit, et deux audits ne se comparent que si l'empreinte coïncide.

⚠️ C'est un **filet de détection a posteriori, pas une garantie d'exclusivité d'accès** : « rien de
détecté » n'est pas la preuve que rien a eu lieu, et l'audit ne voit que les appels d'outils
enregistrés. Quand le harnais permet de restreindre réellement les accès (outils filtrés,
environnement confiné, wrapper n'exposant que `sdig`), la restriction réelle est préférée — l'audit
ne fait plus que confirmer. Un rapport sans audit est déclaré « non audité » en toutes lettres.

## Conditions épinglées et réponses récupérées

Un rapport n'est comparable à un autre que s'il porte ses conditions : md5 du corpus au début **et**
à la fin, version de `sdig`, version du serveur d'agent, hash du template de prompt, graine d'ordre,
version du jeu et variante. Deux runs sans conditions épinglées ne comparent rien.

Une réponse dont la connexion a été perdue alors que le serveur d'agent avait fini le traitement peut
être **récupérée** via le transcript de la session d'examen — à trois conditions : elle porte le flag
`recovered`, l'extrait de transcript qui la fonde est archivé à côté du rapport, et le nombre de
réponses récupérées figure dans le rapport. Sans ces preuves, elle est traitée comme manquante.

Le premier rapport noté d'un jeu gelé est **relu par un second correcteur** indépendant (toutes les
réponses non pleines, les écarts de procédure, un échantillon de réponses pleines). Chaque désaccord
est arbitré contre le corpus par extraction du texte source, citation à l'appui. Une re-notation ne
fait jamais rejouer le jeu : elle relit des réponses existantes, sans coût modèle.

## Règle d'or

Une question qui oriente une décision d'implémentation (réglage de BM25, du corpus, du prompt)
n'est plus une question de mesure : elle part dans `eval/queries.json`. Un jeu de test se gèle,
sinon il ne mesure plus que lui-même.
