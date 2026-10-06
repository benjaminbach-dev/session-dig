# Validation ciblée MCP chrono sur PC — 05/10/2026

## Portée et environnement

Revalidation par le principal après l'implémentation `37ae1a6`, sur autorisation
explicite de l'utilisateur : lancement manuel de `node bin/sdig.js mcp`, puis
reload de la session Pi et appels des outils MCP sdig exposés. Serveur de
production local `127.0.0.1:18767`, corpus réel courant, sans ingestion,
réindexation, réparation ni modification de configuration. Aucun autostart.

`sdig_status` : **2 368 sessions / 89 449 événements** (opencode : 2 055 / 79 058 ;
pi : 313 / 10 391), layout v2, vue disponible. Ce relevé décrit la vue archivée,
pas une synchronisation avec les sources vivantes.

Les contenus privés, identifiants, titres et extraits restent hors de ce bilan.
Le banc naturel complet n'a pas été rejoué ; aucun nouveau score sur dix n'est
annoncé. Il s'agit d'une validation ciblée de la fonctionnalité, pas d'une
nouvelle passation indépendante par l'agent hermétique.

## Vérifications effectuées par MCP

| Vérification | Résultat |
|---|---|
| Exploration globale `oldest` et `newest`, sans `query` | Ordres temporels demandés observés ; messages canoniques, `score: null`, aucun curseur de recherche. |
| Plus ancienne trace du modèle motivant le change, `limit: 1` | Date de référence du banc privé retrouvée, contrairement au résultat tardif du banc historique. |
| Distinction trace portant le modèle / utilisation assistant | Premier record tous rôles = user ; premier assistant immédiatement après, dans la même session et à la même minute. Le rôle est explicitement filtré pour parler d'utilisation assistant. |
| Borne `before` juste avant le premier assistant de ce modèle | Zéro hit, `total: 0`. |
| Bornes `after` et `before` égales à son `ts`, `limit: 5` | Un hit, `total: 1`, score null. |
| Référence du hit transmise à `sdig_read`, `around`, `ctx: 0` | Même id, timestamp et modèle relus ; fragmentation explicitement incomplète avec `chars: 1`, jamais présentée comme une lecture complète. |
| Chrono avec requête, dans les deux sens | Ordre demandé, score BM25 numérique diagnostique, extraits référencés ; commandes seules également rendues. |
| `relevance` omis puis explicite | Tableaux de hits identiques pour la requête exercée, scores numériques. |
| Exploration `source: pi` | Provenance pi, fidélité structurée, modèle absent explicitement null sur le hit concerné. |
| Exploration `role: title` et source inconnue | Zéro hit et total exact nul. |
| Requête en espaces, stopwords seuls et omission en relevance | Refus serveur `invalid_params`, aucune exploration implicite. |
| Sort inconnu et cursor sur search | Refus par le schéma d'outil du harness AVANT appel ; ce passage ne revendique pas une vérification serveur de ces deux entrées. Les tests de protocole synthétiques couvrent le serveur. |

Les ordres et domaines des scores ont été contrôlés en code sur les résultats,
sans recopier les contenus privés dans le dépôt. Les treize réponses search
réussies contrôlées ne portent aucun `nextCursor` ; leur sérialisation en résultat
d'outil (content + structuredContent) reste comprise entre 662 et 8 747 octets.
Cette mesure n'est pas une capture brute de l'enveloppe JSON-RPC HTTP, ni un test
réel sous pression de budget ; les fixtures dédiées couvrent ces bornes.

## Signalement FTS historique

La recherche MCP `openspec`, `sort: oldest`, bornée avant le 04/05/2026 ne rend
aucun hit dans la vue actuelle. Le faux positif ancien signalé dans le bilan
privé n'est donc **pas reproduit par cet appel MCP**. Sa cause historique n'a pas
été établie ; ce constat ne prouve ni un correctif FTS ni sa résolution générale,
et ne remplace pas une investigation du chemin CLI initialement signalé.

## Conclusion et limites

Le **blocage fonctionnel d'exposition de la chronologie est levé**, avec validation
ciblée sur corpus réel. Le suivi d'`add-mcp-server` ne doit plus affirmer que le MCP
exige toujours une requête texte ou n'offre pas de tri chronologique.

La validation synthétique précédente reste distincte : **270/270** tests ciblés
MCP/search-engine/search/cli-chrono ; elle n'a pas été rejouée dans cette passe
documentaire. Ni la résistance aux mutations concurrentes, ni une empreinte
bitwise avant/après, ni des entrées invalides sur une vue périmée ne sont
revalidées ici. Aucun outil d'écriture du corpus n'a été appelé.

**J-MCP / MVP plein et archivage restent ouverts** : aucune nouvelle note du banc
complet, anomalie FTS historique non expliquée et décision de clôture distincte.
Ordre d'archivage inchangé : `add-mcp-server` avant `add-mcp-chrono`.
