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

1. **rappel** — la session source est-elle citée ?
2. **fidélité** — les faits attendus sont-ils présents, sans affirmation interdite ni invention ?

Une abstention honnête vaut mieux qu'une invention : l'abstention est un échec de rappel,
l'invention est un échec de fidélité *et* un signal de fiabilité négatif. Rapporter les scores par
étiquette de spécificité (`high` seul, puis `high`+`medium`, puis ensemble) — un score global qui
mélange culture générale et archive ne dit rien.

## Règle d'or

Une question qui oriente une décision d'implémentation (réglage de BM25, du corpus, du prompt)
n'est plus une question de mesure : elle part dans `eval/queries.json`. Un jeu de test se gèle,
sinon il ne mesure plus que lui-même.
