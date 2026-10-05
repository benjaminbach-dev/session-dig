# Validation PC — 05/10/2026

**J-MCP toujours NON déclaré ; aucun change clos ni archivé.** Ce bilan complète
[celui du 02/10](validation-pc-2026-10-02.md) sans le remplacer. Données privées,
contenu de sessions et chemins des archives de validation restent hors Git.

## Environnement

PC cible T14s (Manjaro, noyau 6.18.49), Node v26.8.1, ~19 Gio RAM libres,
138 Go disque libres. Dépendances locales installées ce jour via `npm ci`
(consentement explicite) : `@modelcontextprotocol/sdk` **1.31.0**, `zod`
**3.25.76** ; `better-sqlite3` 13.0.3 déjà fonctionnel (module natif vérifié).

## Suite de tests complète sur PC

- Premier rejeu : **534/535** (1 échec). Diagnostic worker (reproduit 5 rejeus,
  2 échecs, même test) : test **flaky** `test/mcp-read.test.js` « frontière
  1 point » — l'enveloppe mesurée contient `freshness.indexMtime` (float), dont
  la longueur JSON varie (13–19 caractères) selon les fractions de µs du mtime ;
  le test réécrit la vue à chaque sonde, la frontière de budget bouge de quelques
  octets. Non lié au code ni au PC (probablement masqué sur PRoot par une
  granularité de mtime plus grossière — non prouvé).
- Correctif (commit `fa60147`) : gel du mtime de la vue dans le test
  (`fs.utimesSync`), motif déjà utilisé par `mcp-read-fragments.test.js`.
  Suite complète après correctif : **535/535, exit 0, ~25,5 s** ; test cible
  stable sur 15 runs.

## Ingestion initiale sur corpus réel (première fois sur ce PC)

Home par défaut (vide avant : `sdig status` → corpus absent ; les archives de
validation dédiées du 02/10 restent séparées et intactes). Sources : base
opencode ~5,6 Gio + 319 fichiers de session pi (107 Mo).

| Mesure | Valeur |
|---|---|
| Durée passe initiale | **39,2 s** (exit 0) |
| Pic RSS (VmHWM échantillonné) | **~2,34 Gio** |
| Passe delta immédiate | 0,32 s ; +6 événements (sessions pi vivantes), watermark respecté |
| Corpus produit | **909 Mo** : raw 575 Mo (98 398 preuves), index.db 239,5 Mio, events 94 Mo |
| Compteurs `status` | 2 368 sessions (pi 313, opencode 2 055) ; 89 449 événements ; vue à jour |

Sanity search CLI (requête anodine, `--limit 3`) : exit 0, 3 hits, **0,11 s**.
Écarts de comptage pi non résolus (321 `.jsonl` trouvés vs 313 suivis — règle
de découverte documentée, non vérifiés fichier à fichier) ; lignes pi non
ingérées comptées (model_change, thinking_level_change, role:system, etc.),
conformes à la conception.

## Client MCP réel sur corpus réel (première fois)

Serveur de production `sdig mcp` sur `127.0.0.1:18767` (sans jeton, loopback),
client officiel SDK `StreamableHTTPClientTransport` 1.31.0.

| Étape | Résultat | Durée |
|---|---|---|
| `initialize` | protocolVersion 2025-11-25 ; serverInfo session-dig 0.0.0 | 180,7 ms |
| `tools/list` | exactement 3 outils, descriptions conformes (SHA-256 = dépôt) | 116,4 ms |
| `sdig_search` (limit 10) | 10 hits, 8 groupes, `total=null`, aucun `nextCursor` | 95,1 ms |
| `sdig_read` session complète (chars 400) | 37 pages, 15 051 points, max page 50 708 o | 549,7 ms |
| `sdig_read` pleine (`full`) | 1 page, 79 956 o | 74,7 ms |
| `sdig_read` ciblé 384 toolCalls (chars 40) | 582 pages, 960 fragments, max 5 fragments/appel | (incluse ci-dessous) |
| `sdig_status` | 2 368 sessions / 89 449 événements, rawFiles null, rawReferences 98 382 | 982 ms |
| Reconnexion client | initialize + search OK | 21 ms |
| Redémarrage serveur | SIGTERM propre, port libéré ; curseur d'avant → `invalid_cursor` | 148,1 ms (init) |

- **Recollement prouvé par hash** (jamais par affichage de contenu) : texte et
  commandes, **0 écart gap/overlap**, points de code égaux aux sommes SQL
  indépendantes (SQLite), 79 appels complets, 384 appels/32 099 points au test
  ciblé.
- **Requêtes invalides** : codes fermés (`-32602`, `invalid_params`,
  `invalid_cursor`, `unknown_session`, `invalid_anchor`), aucune fuite d'entrée.
- **Intégrité** : SHA-256 de `index.db` inchangé avant/après campagne ;
  `-wal` 0 o, `-shm` 32 Kio (seule annexe native, exception documentée) ; port
  libéré, aucun process résiduel, `git status` propre.

### Limites restantes (honnêteté)

1. **Pas de commande volumineuse dans le corpus réel** (maximum ~203 points sur
   toute la vue) : la fragmentation des commandes n'est exercée en réel que par
   `chars:40` ; le recollement >600 K reste couvert par les fixtures.
2. **Classement de journal approximatif** : les erreurs applicatives des
   handlers (codes fermés corrects côté client) sont journalisées avec
   `outcome:"internal"` (`src/mcp/server.js`) — cosmétique, sans fuite.
3. Non testés : jeton, concurrence >1 (`busy`), timeout applicatif, en-têtes
   Host/Origin forgés, cache froid disque.
4. Passe `--rebuild` du corpus réel non exécutée (lot B restant).

## Lot B — rebuild, empreinte et mesures (05/10, même journée)

| Mesure | Valeur |
|---|---|
| Empreinte corpus (md5 agrégé) | `47b977e3246ec6cde364fbd9e066c3fa`, 100 720 fichiers / 360,5 Mo — **identique sur 3 runs (avant ×2, après rebuild)**, sortie octet à octet |
| Rebuild vue (`sdig index`) | **8,98 s**, RSS ~207 Mio, comptes identiques (2 368 / 89 449), `index.db` même taille (SHA changé, normal) |
| Recherche CLI `--json` (69 req., chaud) | p50 **114,8 ms**, p95 **136,3 ms** — plancher process+ouverture DB ~86–96 ms ⇒ travail BM25 ~20–40 ms |
| Lecture `read --at` (8 sessions, chaud) | p50 122,8 ms, p95 145,2 ms |
| MCP `sdig_search` (20 appels, chaud) | p50 **44,1 ms**, p95 **65,6 ms** — ~2,5–3× plus rapide que la CLI (pas de redémarrage de process) |

Limites : **cache froid non mesurable** (pas de sudo/drop_caches) ; RSS par échantillonnage
0,2 s ; avertissement de fraîcheur source pi vivante (normal, source active).

## Banc synthétique sur machine cible (05/10)

`node scripts/bench.js` (graine 20260920, tmpfs, cache froid du banc) :

| | 100k (200 sess.) | 500k (1 000 sess.) | cibles |
|---|---|---|---|
| Ingestion initiale | 9,6 s | **27,6 s** | — |
| Delta (1 msg session monstre) | 68 ms | 311 ms (3 shards) | — |
| Indexation complète | 2,3 s | 9,4 s | — |
| Recherche rendue p95 | 114 ms | **499 ms** | < 100 ms @ 500k — **ÉCART documenté (5×)** |
| `read --at` | 20 ms | 71 ms (30 898 msgs) | < 100 ms @ 10k ✓ |
| Preuve par blocs | 0,4 ms | 0,3 ms | ✓ |
| RSS max banc | 355 Mo | **375 Mo** | < 512 Mo ✓ |

La cible p95 recherche n'est **pas atteinte à 500k** (499 ms) ; la note de cadrage
du change (tâches scale-corpus) s'applique : objectifs justifiés, pas prérequis du
premier jalon solo local ; arbitrage à prévoir au lot C (le plancher CLI
process+ouverture ~86–96 ms borne déjà seule la cible à ~100 ms par requête).

## Ce qui reste avant J-MCP / clôture

- Lot B de scale-corpus : rebuild depuis le corpus réel, mesures restantes
  (cache froid, banc étendu si décidé), bilan consolidé.
- Décisions de clôture et ordre d'archivage (`add-pi-adapter` avant
  `add-cli-chronological-sort`) : explicites, au principal.
