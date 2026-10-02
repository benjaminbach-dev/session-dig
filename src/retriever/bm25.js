// Retriever bm25 : FTS5 sur la vue dérivable (change scale-corpus).
// Interface contractuelle : { name, index(corpus), search(query) -> hits }.
// `index` opère DEPUIS LE CORPUS EN FLUX (rebuild de la vue) — l'ancienne signature
// `index(events)` sur tableau matérialisé est retirée : l'interface ne permet plus
// de forcer le chargement complet du corpus en mémoire. La sémantique de recherche
// (stopwords, phrases pointées, OR pondéré, snippets, filtres) est conservée — les
// requêtes dorées ne bougent pas — aux corrections de spec près (sous-lot search A) :
// départage binaire des rangs égaux AVANT la limite, filtre `session` en préfixe
// LITTÉRAL échappé, erreur d'entrée typée `SearchQueryError`, option opt-in
// `boundedText` (extraits bornés sans charger `text`/`cmd` complets).
import Database from 'better-sqlite3'
import { buildView, viewPath, eventCols } from '../view.js'
import { corpusPaths } from '../paths.js'

export const name = 'bm25'
export { eventCols }

/**
 * index(root, dbFile?) : (re)construit la vue dérivable (index BM25) depuis le
 * seul corpus, en flux. Idempotent ; jetable et entièrement reconstruisable.
 * Retourne { events, dbFile } (synchrone : le parcours est en flux, pas en I/O async).
 */
export function index (root = corpusPaths().root, dbFile = viewPath(root)) {
  return buildView(root, { dbFile })
}

// ── recherche : sémantique inchangée, exécutée sur la vue ──

// Stopwords compacts fr+en (décision 17/09 motivée par l'éval : « comment marche la
// compaction » perdait contre des sessions bourrées d'occurrences d'« opencode »).
const STOP = new Set(('le la les l un une des de d au aux et ou mais donc car ni or ne pas plus tres tres comme quand alors si ca ce cet cette ces ceux ' +
  'mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs qui que quoi dont ou comment pourquoi combien ' +
  'est sont etait ete etre avoir ai as ont avons avez avait fait faire fais fait peut peux pour par avec sans sous sur dans entre vers chez depuis pendant apres avant ' +
  'tout tous toute toutes rien personne chaque quelque chose the a an and of to in on for with is are be was were it its this that not no do does did have has had will would can could should ' +
  'i you he she we they my your his her our their').split(' '))

function ftsQuery (q, joiner = 'AND') {
  // Jetons étendus : un point interne (chutes.ai, opencode.ai) devient une PHRASE
  // FTS5 (« chutes ai ») — discrimination des marques/noms de domaine sans indexer plus.
  const rawTokens = q.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) || []
  const terms = []
  for (const raw of rawTokens) {
    const clean = raw.replaceAll('"', '')
    if (clean.includes('.')) {
      const parts = clean.split('.').filter(Boolean)
      if (parts.length) terms.push(`"${parts.join(' ')}"`)
      continue
    }
    if (STOP.has(clean.toLowerCase())) continue
    terms.push(`"${clean}"`)
  }
  if (!terms.length) throw new SearchQueryError()
  return terms.join(` ${joiner} `)
}

// ── Erreur d'ENTRÉE de recherche (ensemble fermé) ───────────────────────────
// `no_terms` : requête sans terme exploitable après retrait des stopwords. Une
// façade (handler MCP) peut la distinguer d'un échec interne et répondre
// `invalid_params` plutôt que `internal`, sans examiner le message. Aucune autre
// entrée n'emprunte cette classe.
export const SEARCH_ERROR_NO_TERMS = 'no_terms'
export class SearchQueryError extends Error {
  constructor (code = SEARCH_ERROR_NO_TERMS) {
    super('requête vide ou sans termes exploitables (stopwords seuls ?)')
    this.name = 'SearchQueryError'
    this.code = code
  }
}
export function isSearchQueryError (err) {
  return err instanceof SearchQueryError
}

/**
 * Préfixe LIKE LITTÉRAL : `%`, `_` et `\` sont échappés pour que le filtre
 * `session` soit un vrai préfixe de chaîne (jamais un motif de joker), avec
 * `ESCAPE '\'` dans la clause SQL.
 */
function likePrefix (value) {
  return value.replace(/[\\%_]/g, '\\$&') + '%'
}

/**
 * Prédicats de filtres EXACTS partagés par les trois chemins de recherche
 * (relevance, chrono avec mots-clés, chrono sans mots-clés) : `repo`, préfixe
 * littéral `session`, bornes `after`/`before`, `model` sous-chaîne, `role`,
 * `agent`, `source` exact (COALESCE héritée = opencode). Aucun prédicat `q`.
 * `source` inconnue ⇒ prédicat exact ⇒ zéro hit, jamais une erreur.
 */
function filterSql (query) {
  const { repo, session, after, before, model, role, agent, source } = query
  const clauses = []
  const params = {}
  if (repo) { clauses.push('e.repo = @repo'); params.repo = repo }
  if (session) { clauses.push("e.session_id LIKE @session ESCAPE '\\'"); params.session = likePrefix(session) }
  if (after != null) { clauses.push('e.ts >= @after'); params.after = after }
  if (before != null) { clauses.push('e.ts <= @before'); params.before = before }
  if (model) { clauses.push('e.model LIKE @model'); params.model = `%${model}%` }
  if (role) { clauses.push('e.role = @role'); params.role = role }
  if (agent) { clauses.push('e.agent = @agent'); params.agent = agent }
  if (source && source !== 'all') {
    clauses.push("COALESCE(json_extract(e.json, '$.source'), 'opencode') = @source")
    params.source = source
  }
  return { clauses, params }
}

// Plafond de CARACTÈRES (points de code) des extraits en mode `boundedText`.
// La borne `tokens` de `snippet()` ne borne PAS la longueur : un unique token
// énorme (ex. 60 000 caractères) serait rendu entier, donc `substr` s'applique
// CÔTÉ SQL, avant tout transfert vers Node. Aligné sur le plafond de texte par
// message du design D3 (20 000 caractères).
export const MAX_BOUNDED_EXCERPT_CHARS = 20000

/**
 * search(view, { q, repo, session, after, before, model, role, agent, source, limit, plain, boundedText })
 * → hits ordonnés par rang BM25 (croissant = meilleur), départage des rangs
 * ÉGAUX par identifiant canonique complet en ordre binaire (`e.id COLLATE BINARY`),
 * AVANT la limite (sélection top-k stable). `view` est un chemin de base SQLite
 * (compat CLI/tests) ou une Database déjà ouverte : une commande de lecture
 * multi-étapes (hits → voisins → compteurs) passe une Database unique et
 * s'exécute ainsi dans une seule transaction de lecture (un seul snapshot —
 * aucune génération intercalée par une publication concurrente).
 *
 * `session` est un PRÉFIXE LITTÉRAL (métacaractères LIKE `%`/`_`/`\` échappés).
 * `boundedText` (opt-in, défaut `false`, CLI compatible) : les colonnes `text` et
 * `cmd` COMPLETES ne sont PAS chargées ; `textLen`/`cmdLen` en donnent les longueurs
 * (points de code). Les extraits `snip`/`snipPlain`/`snipCmd` sont coupés DANS SQL
 * à `MAX_BOUNDED_EXCERPT_CHARS` points de code (la borne `tokens` de FTS5 ne borne
 * pas la longueur d'un token unique énorme), et `snipLen`/`snipPlainLen`/
 * `snipCmdLen` portent leurs longueurs RÉELLES non bornées pour signaler la coupure
 * exactement. Chemin CLI par défaut inchangé (colonnes et extraits non bornés).
 */
export function search (view, query) {
  const own = typeof view === 'string'
  const db = own ? new Database(view, { readonly: true, fileMustExist: true }) : view
  try {
    const { q, limit = 20 } = query
    const match = ftsQuery(q, 'OR')
    // snippet col0 = text, col1 = cmd. Marqueurs ANSI par défaut (TUI), neutres si plain.
    // snipPlain = jumeau SANS décorations (bug 20/09 : la détection de coupure ne doit
    // jamais mesurer le texte décoré — en --plain, »…« gonfle la longueur et masque la coupure).
    const open = query.plain ? '»' : '\x1b[1;33m'
    const close = query.plain ? '«' : '\x1b[0m'

    const { clauses, params: filterParams } = filterSql(query)
    const where = ['events_fts MATCH @match', ...clauses]

    // Projection des textes : par défaut les colonnes complètes ; en mode borné
    // (opt-in MCP) seules les LONGUEURS sont transférées, jamais `e.text`/`e.cmd`.
    const boundedText = query.boundedText === true
    const innerText = boundedText
      ? 'length(e.text) AS textLen, length(e.cmd) AS cmdLen'
      : 'e.cmd, e.text'
    // Indicateurs EXACTS (opt-in) décidés CÔTÉ SQL, avant tout transfert : l'égalité
    // STRICTE `snippet == colonne` (jamais une comparaison de longueurs — une
    // ellipse FTS ou une fenêtre `tokens` peut tromper une longueur) et la variante
    // `cmd` SANS marqueurs pour les hits à commande seule.
    const innerExtra = boundedText
      ? `,
               snippet(events_fts, 1, '', '', '…', 14) AS snipCmdPlain,
               CASE WHEN e.text IS NOT NULL AND snippet(events_fts, 0, '', '', '…', 14) = e.text THEN 1 ELSE 0 END AS snipFull,
               CASE WHEN e.cmd IS NOT NULL AND snippet(events_fts, 1, '', '', '…', 14) = e.cmd THEN 1 ELSE 0 END AS snipCmdFull`
      : ''
    // En mode borné, `substr(..., @snipChars)` coupe les extraits DANS SQLITE et
    // `length(...)` expose les longueurs RÉELLES (non bornées) de chaque extrait,
    // pour qu'une façade puisse signaler la coupure exactement sans réestimer.
    const outerProjection = boundedText
      ? `id, session_id, ts, role, agent, repo, model, textLen, cmdLen, source,
         substr(snip, 1, @snipChars) AS snip, length(snip) AS snipLen,
         substr(snipPlain, 1, @snipChars) AS snipPlain, length(snipPlain) AS snipPlainLen,
         CASE WHEN length(snipPlain) > @snipChars THEN 1 ELSE 0 END AS snipPlainCut,
         snipFull,
         substr(snipCmdPlain, 1, @snipChars) AS snipCmdPlain, length(snipCmdPlain) AS snipCmdPlainLen,
         snipCmdFull,
         substr(snipCmd, 1, @snipChars) AS snipCmd, length(snipCmd) AS snipCmdLen,
         score`
      : `id, session_id, ts, role, agent, repo, model, cmd, text, source,
         snip, snipPlain, snipCmd, score`

    // Sous-requête : les trois `snippet()` sont calculés UNE fois par ligne, puis
    // bornés/jaugés dans la projection externe. Le tri binaire des rangs égaux
    // s'applique APRÈS la fenêtre, AVANT la limite.
    const sql = `
      SELECT ${outerProjection}
      FROM (
        SELECT e.id, e.session_id, e.ts, e.role, e.agent, e.repo, e.model,
               ${innerText},
               COALESCE(json_extract(e.json, '$.source'), 'opencode') AS source,
               snippet(events_fts, 0, @open, @close, '…', 14) AS snip,
               snippet(events_fts, 0, '', '', '…', 14) AS snipPlain,
               snippet(events_fts, 1, @open, @close, '…', 14) AS snipCmd${innerExtra},
               rank AS score
        FROM events e JOIN events_fts ON e.rowid = events_fts.rowid
        WHERE ${where.join(' AND ')}
      )
      ORDER BY score, id COLLATE BINARY
      LIMIT @limit`

    const params = { match, limit, open, close, ...filterParams }
    if (boundedText) params.snipChars = MAX_BOUNDED_EXCERPT_CHARS
    return db.prepare(sql).all(params)
  } finally {
    if (own) db.close()
  }
}

/**
 * searchChrono(view, { q, sort: 'oldest'|'newest', ...filtres, limit, plain })
 * → hits AVEC mots-clés ordonnés CHRONOLOGIQUEMENT sur l'ENSEMBLE des matches
 * filtrés (sélection globale, puis `LIMIT`), jamais sur un top-k BM25 réutilisé.
 * La clause de matching (`ftsQuery(q, 'OR')` : stopwords fr+en, tokenizer unicode,
 * phrases pour jetons pointés) et les prédicats de filtres sont IDENTIQUES à
 * `search()` ; seul l'`ORDER BY` change : `(e.ts, e.id COLLATE BINARY)` dans le
 * sens demandé. `rank` (BM25) reste projeté en `score` DIAGNOSTIC (numérique),
 * sans jamais intervenir dans l'ordre. `ts = 0` est une valeur valide.
 */
export function searchChrono (view, query) {
  const own = typeof view === 'string'
  const db = own ? new Database(view, { readonly: true, fileMustExist: true }) : view
  try {
    const { q, limit = 20 } = query
    const dir = query.sort === 'newest' ? 'DESC' : 'ASC'
    const match = ftsQuery(q, 'OR')
    const open = query.plain ? '»' : '\x1b[1;33m'
    const close = query.plain ? '«' : '\x1b[0m'
    const { clauses, params: filterParams } = filterSql(query)
    const where = ['events_fts MATCH @match', ...clauses]
    const sql = `
      SELECT e.id, e.session_id, e.ts, e.role, e.agent, e.repo, e.model,
             e.cmd, e.text,
             COALESCE(json_extract(e.json, '$.source'), 'opencode') AS source,
             snippet(events_fts, 0, @open, @close, '…', 14) AS snip,
             snippet(events_fts, 0, '', '', '…', 14) AS snipPlain,
             snippet(events_fts, 1, @open, @close, '…', 14) AS snipCmd,
             rank AS score
      FROM events e JOIN events_fts ON e.rowid = events_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY e.ts ${dir}, e.id COLLATE BINARY ${dir}
      LIMIT @limit`
    return db.prepare(sql).all({ match, limit, open, close, ...filterParams })
  } finally {
    if (own) db.close()
  }
}

/**
 * browseChrono(view, { sort: 'oldest'|'newest', ...filtres, limit })
 * → événements SANS mots-clés : aucun `MATCH` FTS, donc aucune requête `'*'`
 * inventée. Le sous-ensemble CANONIQUE est TOUJOURS l'intersection
 * `role ∈ {user, assistant}` ∩ filtre `--role` éventuel : `--role title` ou une
 * valeur inconnue produit ZÉRO hit (jamais l'inclusion d'une ligne de titre).
 * Les événements à texte vide ou à commandes seules sont INCLUS (ce n'est pas un
 * mode FTS). `score` vaut `null` (BM25 non calculé) ; la métadonnée de modèle
 * absente reste `null`, jamais inventée. Filtres et tri `(ts, id BINARY)`
 * identiques à `searchChrono`.
 */
export function browseChrono (view, query) {
  const own = typeof view === 'string'
  const db = own ? new Database(view, { readonly: true, fileMustExist: true }) : view
  try {
    const { limit = 20 } = query
    const dir = query.sort === 'newest' ? 'DESC' : 'ASC'
    const { clauses, params } = filterSql(query)
    const where = ["e.role IN ('user','assistant')", ...clauses]
    const sql = `
      SELECT e.id, e.session_id, e.ts, e.role, e.agent, e.repo, e.model,
             e.cmd, e.text,
             COALESCE(json_extract(e.json, '$.source'), 'opencode') AS source,
             NULL AS score
      FROM events e
      WHERE ${where.join(' AND ')}
      ORDER BY e.ts ${dir}, e.id COLLATE BINARY ${dir}
      LIMIT @limit`
    return db.prepare(sql).all({ limit, ...params })
  } finally {
    if (own) db.close()
  }
}

/** Ordre BINAIRE réel (octets UTF-8), identique à `COLLATE BINARY` de SQLite. */
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'))

/**
 * Voisins BORNÉS pour la façade search (MCP) : jusqu'à `ctx` prédécesseurs et
 * `ctx` successeurs de CHAQUE hit dans SA session, par clé `(ts, id)` — jamais de
 * session entière ni de JSON complet chargé. `text` est coupé DANS SQL (`substr`)
 * et `textLen` porte sa longueur réelle en points de code. Retourne un tableau
 * dédupliqué par `(session_id, id)` (un voisin commun à plusieurs hits n'apparaît
 * qu'une fois, `forRef` = premier hit rencontré dans l'ordre des hits), ordonné en
 * ordre BINAIRE OCTET (UTF-8, comme `COLLATE BINARY`) `(session_id, ts, id)` pour
 * un résultat déterministe. `ctx <= 0` ou aucun hit ⇒ aucun voisin.
 */
export function searchNeighbors (view, hits, ctx, { excerptChars = MAX_BOUNDED_EXCERPT_CHARS } = {}) {
  if (!Array.isArray(hits) || hits.length === 0 || !(ctx > 0)) return []
  const columns = `e.id, e.session_id, e.ts, e.role, e.agent, e.repo, e.model,
      COALESCE(json_extract(e.json, '$.source'), 'opencode') AS source,
      COALESCE(substr(e.text, 1, @excerptChars), '') AS text,
      COALESCE(length(e.text), 0) AS textLen`
  const before = view.prepare(`SELECT ${columns} FROM events e
    WHERE e.session_id = @sid AND e.role != 'title'
      AND (e.ts < @ts OR (e.ts = @ts AND e.id < @id))
    ORDER BY e.ts DESC, e.id DESC LIMIT @ctx`)
  const after = view.prepare(`SELECT ${columns} FROM events e
    WHERE e.session_id = @sid AND e.role != 'title'
      AND (e.ts > @ts OR (e.ts = @ts AND e.id > @id))
    ORDER BY e.ts, e.id LIMIT @ctx`)
  const byKey = new Map()
  for (const h of hits) {
    const params = { sid: h.session_id, ts: h.ts, id: h.id, ctx, excerptChars }
    const forRef = { sessionId: h.session_id, messageId: h.role === 'title' ? null : h.id }
    for (const stmt of [before, after]) {
      for (const nb of stmt.all(params)) {
        const key = `${nb.session_id}\u0000${nb.id}`
        if (!byKey.has(key)) byKey.set(key, { ...nb, forRef })
      }
    }
  }
  return [...byKey.values()].sort((a, b) =>
    binaryCompare(a.session_id, b.session_id) ||
    (a.ts - b.ts) ||
    binaryCompare(a.id, b.id))
}
