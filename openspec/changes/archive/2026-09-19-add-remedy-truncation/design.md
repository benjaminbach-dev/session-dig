# Design — add-remedy-truncation

## C'est un problème de rendu, pas de corpus

Les textes intégraux sont dans `events.jsonl` depuis v0 ; `--json` les rend déjà complets. La perte vient de la limite d'affichage par message du rendu humain. Le remède est donc purement affichage — aucune migration de corpus, aucun changement d'index.

## Le cœur du remède : un marqueur auto-suffisant

L'échec mesuré n'est pas « le modèle n'a pas vu le texte » mais « le modèle a conclu que l'archive ne contenait pas la suite ». La sortie doit donc **dire le contraire d'elle-même** : toute coupure s'accompagne d'un marqueur qui annonce (a) qu'il s'agit d'une limite d'affichage, (b) les compteurs exacts, (c) comment obtenir l'intégral. Format :

```
    ⚠ message tronqué à l'affichage (1 200/5 100 caractères) — intégral : --full | --chars N | sdig search --json
```

Compteurs exacts (pas d'arrondi, séparateur fin pour rester lisible). Le marqueur apparaît aussi sur les fenêtres `--ctx`.

## `--full` et `--chars N`

- `--full` : lève la limite par message. Risque de flood terminal assumé : c'est une demande explicite.
- `--chars N` : fixe la limite (défaut inchangé). Utile pour borner un `--full` trop bavard.
- Les deux s'appliquent à `sdig read` (y compris `--around`/`--ctx`/`--tail`) et à l'affichage des hits de recherche groupés par session.
- Piège connu du parseArgs maison : **déclarer les options dans parseArgs** — une option non déclarée avale la valeur suivante (`--raw` l'a prouvé en v0.1).

## Migration des questions brûlées

Deux questions du jeu naturel ont orienté ce remède : elles cessent d'être des mesures (règle du gel, spec `natural-eval`) et migrent vers `eval/queries.json` — **reformulées par mots-clés**, jamais verbatim (le jeu reste privé ; le harnais de réglage est public). Expect = session source, note de provenance « brûlée (analyse 19/09, troncation) ». Le critère de réussite du remède devient vérifiable : le contenu visé doit être atteignable par le chemin documenté dans le marqueur.

## Non-couvert ici

R2 (filtre temporel simple, option `--at`) : change séparé, motivé par la dérive temporelle (n46, n50). Périmètre volontairement minimal (retour du 20/09) : **masquer les messages postérieurs à un ancrage** (`--at <msgId|ts>`), sans détection automatique des mutations d'état — détecter qu'un message change un état est un chantier autrement ambitieux, hors périmètre.
