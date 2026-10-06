# Validation PC — 06/10/2026 : banc synthétique fidèle

**J-MCP toujours NON déclaré ; aucun change clos ni archivé.** Ce bilan documente
la **correction de l'instrument de banc** (`scripts/bench.js`) et les mesures
reprises avec la méthode corrigée. Il ne remplace pas le
[bilan du 05/10](validation-pc-2026-10-05.md), dont les chiffres restent
**historiques et non comparables à méthode égale**.

## Pourquoi l'ancien instrument était infidèle

Défauts démontrés par relecture du code, pas par mesure :

- il **annonçait** mesurer la recherche rendue et la lecture, mais ne rendait
  rien (`search` + `neighborsBySessionDb` appelés puis résultats jetés ; aucun
  `renderTerminal`, aucune transaction de lecture) ;
- la preuve « volumineuse » lisait un raw existant quelconque, **jamais agrandi**
  (bucket `00` supposé, sans garantie) ;
- le RSS était un **échantillon ponctuel** par phase (`process.memoryUsage().rss`),
  pas le pic OS de la vie du process ;
- le monstre valait une expression arrondie (`N*0.1/(N/N_SESSIONS)`), pas 10 %
  explicites ; la génération pouvait s'arrêter avant `N` ;
- aucune assertion de correction, aucun nettoyage sur échec, et la condition
  « cache froid (tmpfs) » était proclamée sans contrôle.

## Méthode corrigée

- **Paramètres stricts bornés** (`--n`, `--sessions`, `--seed`, `--runs` défaut 20
  min 3, `--raw-mib` défaut 16) validés **avant toute création de tmp** ; options
  inconnues et positionnels refusés (exit 2).
- **Génération EXACTE** : partition explicite (monstre = `floor(N·0.10)`, le reste
  réparti inégalement avec ≥ 1 par session non-monstre) ; `sum = N` vérifié.
- **Preuve géante RÉELLE** : `--raw-mib` Mio de sortie d'outil insérée comme
  `tool part` dans la **source synthétique**, puis **ingérée** ; le raw est lu par
  `streamBytes` et comparé **octets et md5 exacts**. Aucune édition de `raw/`
  hors ingestion.
- **Recherche RENDUE** : `search` + `neighborsBySessionDb` + `renderTerminal`
  (ctx 3) dans **une seule transaction de lecture** (`inReadTx`), sortie jamais
  affichée, mesurée en **octets UTF-8** (`Buffer.byteLength`) — sans hash.
- **`read --at` EN FLUX** : `streamRead` + `readTerminalChunks` vers un **sink
  comptage/hash** (jamais stdout) ; comptes `total`/`visible`/`maskedCount` et
  ancre vérifiés ; hash identique sur deux lectures (déterminisme).
- **Répétitions** après échauffement ; quantile **nearest-rank** (rang = `ceil(p·n)`),
  `n` et méthode affichés (plus de p95 « n=5 = max » implicite).
- **Pic RSS OS cumulatif** : `process.resourceUsage().maxRSS` (KiB → Mio) sur toute
  la vie du process, pas d'échantillon isolé.
- **Phases séparées** : génération, ingestion initiale, delta (+1), passe vide
  stable, rebuild de vue, recherche, `read --at`, preuve géante, **coût fichier pi
  changé**, disque récursif.
- **Phase pi** : fixture JSONL synthétique (1 gros fichier + petits fichiers
  découverte) ; mesurée en initial / append d'1 message / aucun delta ; bytes
  suivis, taille de l'état (inventaire) et durées explicites. La relecture
  intégrale d'un fichier changé n'est **pas** isolée des autres coûts de passe.
- **EXPLAIN QUERY PLAN** des requêtes exactes de l'adaptateur, avec et sans index
  `time_updated` (index créé puis retiré : structure source rendue inchangée).
- **Assertions de correction** (échec non nul) : `N` événements/sessions, delta
  +1, passe vide stable, comptes/ancre de lecture, octets/hash de preuve,
  recherche non vide, rendu non vide, déterminisme.
- **Nettoyage garanti** (`finally`) même en cas d'échec ; `--keep` conserve
  explicitement. Le smoke durable `test/bench-smoke.test.js` vérifie le rapport,
  les assertions, le nettoyage et le refus des arguments invalides **avant tmp**.
- **Conditions honnêtes** : machine/Node/arch consignés, FS **non contrôlé** (ni
  `drop_caches` ni tmpfs revendiqué), cache **non contrôlé**. Les cibles sont
  **indicatives, sans gate**.

## Environnement

Machine T14s (Manjaro, noyau 6.18.49), Node **v26.8.1**, 16 cœurs, ~25,7 Gio RAM
libres, `/tmp` 16 Gio. Fixtures synthétiques uniquement (aucune source réelle,
aucune donnée personnelle).

## Résultats (méthode corrigée, graine 20260920)

| Mesure | smoke n=100 | 20k | 100k | 500k |
|---|---|---|---|---|
| Sessions | 5 | 100 | 200 | 1 000 |
| `--runs` | 3 | 10 | 20 | 20 |
| Génération source | 34 ms | 646 ms | 2,9 s | 11,4 s |
| Ingestion initiale | 42 ms | 1,95 s | 7,3 s | **25,4 s** |
| Delta (+1) | 10 ms | 36 ms | 78 ms | 324 ms |
| Passe vide | 7 ms | 13 ms | 20 ms | 83 ms |
| Rebuild vue | 12 ms | 637 ms | 1,7 s | 9,0 s |
| Recherche rendue p95 (agrégat 5 requêtes) | 16 ms | 58 ms | **115 ms** | **536 ms** |
| `read --at` p95 (monstre) | 2,6 ms (11 msgs) | 22 ms (2 001) | 50 ms (10 001) | 277 ms (50 001) |
| Preuve géante (blocs) | 1 Mio, 4,8 ms | 8 Mio, 31 ms | 16 Mio, 32 ms | 32 Mio, 64 ms |
| Pi initial | 28 ms | 181 ms | 746 ms | 3,3 s |
| Pi append (1 msg, relecture fichier) | 15 ms | 161 ms | 1,0 s | 5,3 s |
| Pi sans delta (stat seul) | 6 ms | 6 ms | 3,7 ms | 5,3 ms |
| Disque tmp total | 2,7 Mio | 55 Mio | 229 Mio | 990 Mio |
| **Pic RSS OS cumulatif** | 111 Mio | 213 Mio | 363 Mio | **468 Mio** |

Cibles affichées (indicatives, **non un gate**) : recherche p95 < 100 ms @ 500k ;
`read --at` p95 < 100 ms @ 10k msgs ; RSS < 512 Mio.

- **`read --at`** : 50 ms p95 @ 10 001 msgs → sous la cible ; 277 ms @ 50 001 msgs
  (session monstre du banc, hors cible 10k).
- **RSS** : 468 Mio @ 500k → sous 512 Mio, pic **cumulatif** de la vie du process.
- **Recherche rendue p95** : la mesure agrège **un cycle de 5 requêtes
  hétérogènes** (`runs` itérations), ce n'est pas une requête unique ; le `n` et la
  méthode nearest-rank sont affichés. À 500k, **536 ms** : cible 100 ms **non
  atteinte**, écart **documenté**. **Non comparable** au 499 ms du 05/10 (méthode
  différente : rendu réel + voisins en transaction ici, requêtes non rendues
  auparavant) — la seule comparaison honnête est « même ordre de grandeur, mesure
  non équivalente ». Le plancher CLI (process + ouverture ~86–96 ms) borne déjà la
  cible. **Aucun gate ni arbitrage automatique** dans ce lot.
- **Preuve géante** : octets et md5 **exacts** à chaque échelle (générée dans la
  source, écrite par l'ingestion).

## EXPLAIN QUERY PLAN (source synthétique) — requêtes EXACTES de `opencode-page.js`

Reproduites depuis `src/adapter/opencode-page.js` (`adaptPaged`), avec des
paramètres **représentatifs** (watermark récent = max − 1000 de chaque table, pas `-1`) ; index de
tête `time_updated` créé puis **retiré** (structure source rendue inchangée).

| Requête (exacte) | Sans index de tête `time_updated` | Avec index de tête |
|---|---|---|
| sessions fallback `WHERE time_updated > ? AND id > ? ORDER BY id LIMIT ?` | `SEARCH session USING INDEX sqlite_autoindex_session_1 (id>?)` | idem (l'index `time_updated` n'est pas retenu) |
| sessions keyset `WHERE time_updated > ? AND (time_updated > ? OR (time_updated = ? AND id > ?)) ORDER BY time_updated, id LIMIT ?` | `SCAN session` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH session USING INDEX session_updated_idx (time_updated>?)` + `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` |
| messages du delta `WHERE time_updated > ? ORDER BY session_id, time_created, id` | `SCAN message USING INDEX message_session_idx` | **identique** (`SCAN message USING INDEX message_session_idx`) |

**Conclusion observée, à ne pas surinterpréter** :

- le filtre watermark est exécuté par la base (jamais filtré après coup) ;
- un index de tête `time_updated` est utilisé par la pagination **sessions keyset**
  (mais un tri résiduel subsiste ; le plan seul ne mesure pas un gain de durée) ;
- il **ne rend PAS** la requête messages du delta « O(delta) » : SQLite continue
  d'utiliser l'index d'ordre `message_session_idx` (session_id, time_created, id)
  et **scanne** — l'`ORDER BY session_id, time_created, id` n'est pas fourni par un
  index `time_updated`. Aucune revendication d'O(delta) sur les messages n'est donc
  tirée de ce plan.

Ces plans sont **synthétiques** (source de test) et ne remplacent pas une
validation sur la base source réelle.

## Limites et ce qui reste

- **Cache non contrôlé** : pas de `drop_caches` (pas de sudo) ; les mesures
  répétées ne prétendent pas à un cache froid.
- **Comparabilité** : la méthode a changé le 06/10 ; les chiffres du 05/10 ne sont
  pas comparables à méthode égale.
- **500k mesuré, pas « cible validée »** : le 500k est un point de mesure sur
  fixtures, pas la preuve d'un objectif universel ; la cible recherche reste un
  écart.
- **Coût pi changé** : relecture intégrale assumée d'un fichier changé, **non
  isolée** des autres coûts de passe (découverte, staging, publication) ; pas de
  promesse d'indépendance.
- **Plans SQL synthétiques** : ne remplacent pas la validation PC réelle.
- **Banc hors `npm test`** ; seul le smoke (`test/bench-smoke.test.js`) est durable.

## Commandes

```sh
node scripts/bench.js --n 100 --sessions 5 --runs 3 --raw-mib 1     # smoke manuel
node scripts/bench.js --n 20000 --sessions 100 --runs 10 --raw-mib 8
node scripts/bench.js --n 100000 --sessions 200 --runs 20 --raw-mib 16
node scripts/bench.js --n 500000 --sessions 1000 --runs 20 --raw-mib 32
node scripts/bench.js --help
node --test test/bench-smoke.test.js
```
