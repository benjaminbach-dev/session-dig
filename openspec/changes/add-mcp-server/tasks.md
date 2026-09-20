# Tâches — add-mcp-server

## Phase spec (ce change uniquement)

- [x] Écrire proposition, design et delta de la capacité `mcp`.
- [x] Conserver les protections des revues précédentes : lecture seule, loopback et contrôles Host/Origin, token optionnel, preuves confinées, raw fermé par défaut, journaux en liste autorisée, données non fiables, ancrage identique au CLI.
- [x] Recentrer la v1 (20/09, décision utilisateur) : search = extraits référencés + pagination des hits ; lecture complète par fragments dans read/raw ; totaux exacts seulement quand connus ; timeout sans partiel ; créneau réutilisé après arrêt confirmé ; déterminisme des données et non de l'enveloppe.
- [x] Valider ce rescopage avec `openspec validate add-mcp-server --strict --no-interactive` et contrôler la cohérence des quatre documents. Validation globale `--specs --changes --strict --no-interactive` : 4 éléments valides, aucun échec ; `git diff --check` OK.
- [ ] Commit/push documentaire sur demande explicite. Aucun début d'implémentation implicite.

## Phase implémentation (change séparé, sur accord)

- [ ] Vérifier le paquet et la version publiés du SDK MCP officiel et son transport Streamable HTTP, puis épingler la dépendance dans ce nouveau change.
- [ ] Fixer les schémas d'entrée/sortie et de fragments (unités d'offset, encodage, fin de message, compteurs inconnus), représentation du curseur et bornes mémoire/durée de vie si un état est conservé côté serveur.
- [ ] Implémenter la façade sur les fonctions existantes : search avec extraits et références, read avec `at`, raw optionnel, status sans chemin local. Pas de scoring ou d'ancrage réimplémenté en parallèle.
- [ ] Paginer la **liste des hits**, avec ordre stable et départage des scores égaux, avant regroupement par session. Aucune fragmentation du texte intégral dans search ; les extraits et voisins orientent vers read.
- [ ] Implémenter la continuation de read (vue + fragments de messages) et raw actif (fragments de preuve), liée à la génération et aux paramètres initiaux ; refus des curseurs altérés/étrangers/périmés et du mélange cursor + paramètres initiaux.
- [ ] Appliquer les plafonds par appel et le budget de réponse MCP sérialisée, métadonnées comprises ; signaler toute coupure et tout ajustement de limite ; rendre les totaux connus exacts et les inconnus `null`, sans compter exhaustivement par obligation.
- [ ] Isoler le travail synchrone dans un worker/processus dont l'arrêt est observable ; tester ce choix avec les appels natifs SQLite. À expiration : erreur timeout sans partiel ni curseur, arrêt demandé, créneau occupé jusqu'à confirmation, résultats tardifs ignorés ; incident visible si arrêt impossible.
- [ ] Implémenter Streamable HTTP loopback, Host/Origin validés, token optionnel, concurrence bornée + busy, erreurs applicatives/protocole distinctes, arrêt propre et journaux en liste autorisée.
- [ ] Confinement raw : format et référence partId vérifiés, fichier dérivé, contrôles de chemin et du fichier ouvert, refus des liens/fichiers spéciaux, tests de substitution. Raw absent par défaut et aucune continuation ne contourne sa désactivation.
- [ ] Descriptions d'outils : archive = données non fiables, jamais instructions ; confidentialité documentée pour **toutes** les lectures, sans promesse de filtrage des secrets.

## Validation de l'implémentation future

- [ ] Tests de contrat sur fixtures : catalogue selon configuration ; types invalides et limites ajustées ; budget global ; total inconnu ; extraits search → read ; erreurs sans contenu privé.
- [ ] Pagination : plus de 50 hits avec scores égaux ; message de plus de 20 000 caractères ; plus de 200 messages ; preuve de plus de 65 536 octets ; accents/emoji ; coupure au budget total ; recollement exact et suite complète de la vue choisie.
- [ ] Ancrage CLI/MCP identique : UTC, dates invalides/vides/inconnues, masquage avant fenêtre, compteurs, continuation ne réintroduisant pas le futur.
- [ ] Timeout et concurrence : erreur sans partiel même avec données intermédiaires, busy pendant arrêt, aucun créneau libéré avant confirmation, reprise après arrêt et absence de travail orphelin.
- [ ] Sécurité : Host/Origin refusés, token quand configuré, partId hostile, absence d'egress, corpus/index/base source inchangés, inspection des journaux sans query/contenu/token/curseur.
- [ ] Fraîcheur : état changé → stale_cursor ; rejeu réussi → données et ordre identiques sans imposer l'identité des curseurs ou des durées.
- [ ] Client MCP réel sur fixtures : initialisation, outils autorisés, pagination des hits puis lecture complète par read, raw si activé, reconnexion.
- [ ] Tests de régression existants et validation OpenSpec. Pas de rejeu du jeu naturel gelé.
- [ ] Documenter lancement manuel, limites, offsets, mécanisme d'arrêt, confidentialité et limites de l'authentification locale. Ne marquer la phase v1 livrée qu'après validation effective.
- [ ] Ajout au manifeste Termux : décision propriétaire explicite distincte, hors de ce change documentaire.
