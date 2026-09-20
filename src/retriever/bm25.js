// Retriever bm25 : FTS5 sur la vue dérivable (change scale-corpus).
// Interface contractuelle : { name, index(corpus), search(query) -> hits }.
// `index` opère DEPUIS LE CORPUS EN FLUX (rebuild de la vue) — l'ancienne signature
// `index(events)` sur tableau matérialisé est retirée : l'interface ne permet plus
// de forcer le chargement complet du corpus en mémoire. La sémantique de recherche
// (stopwords, phrases pointées, OR pondéré, snippets, filtres) est strictement
// conservée — les requêtes dorées ne bougent pas.
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
  if (!terms.length) throw new Error('requête vide ou sans termes exploitables (stopwords seuls ?)')
  return terms.join(` ${joiner} `)
}

/**
 * search(view, { q, repo, session, after, before, model, role, agent, limit })
 * → hits ordonnés par rang BM25 (croissant = meilleur). `view` est un chemin de
 * base SQLite (compat CLI/tests) ou une Database déjà ouverte : une commande de
 * lecture multi-étapes (hits → voisins → compteurs) passe une Database unique et
 * s'exécute ainsi dans une seule transaction de lecture (un seul snapshot —
 * aucune génération intercalée par une publication concurrente).
 */
export function search (view, query) {
  const own = typeof view === 'string'
  const db = own ? new Database(view, { readonly: true, fileMustExist: true }) : view
  try {
    const { q, repo, session, after, before, model, role, agent, limit = 20 } = query
    const match = ftsQuery(q, 'OR')
    // snippet col0 = text, col1 = cmd. Marqueurs ANSI par défaut (TUI), neutres si plain.
    // snipPlain = jumeau SANS décorations (bug 20/09 : la détection de coupure ne doit
    // jamais mesurer le texte décoré — en --plain, »…« gonfle la longueur et masque la coupure).
    const open = query.plain ? '»' : '\x1b[1;33m'
    const close = query.plain ? '«' : '\x1b[0m'

    const where = ['events_fts MATCH @match']
    const base = { repo, session, after, before, model, role, agent }
    if (repo) { where.push('e.repo = @repo'); }
    if (session) { where.push('e.session_id LIKE @session') }
    if (after != null) { where.push('e.ts >= @after') }
    if (before != null) { where.push('e.ts <= @before') }
    if (model) { where.push('e.model LIKE @model') }
    if (role) { where.push('e.role = @role') }
    if (agent) { where.push('e.agent = @agent') }

    const sql = `
      SELECT e.id, e.session_id, e.ts, e.role, e.agent, e.repo, e.model, e.cmd, e.text,
             snippet(events_fts, 0, @open, @close, '…', 14) AS snip,
             snippet(events_fts, 0, '', '', '…', 14) AS snipPlain,
             snippet(events_fts, 1, @open, @close, '…', 14) AS snipCmd,
             rank AS score
      FROM events e JOIN events_fts ON e.rowid = events_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT @limit`

    const params = { match, limit, open, close }
    for (const k of Object.keys(base)) if (base[k] != null) params[k] = typeof base[k] === 'string' ? (k === 'session' ? `${base[k]}%` : (k === 'model' ? `%${base[k]}%` : base[k])) : base[k]
    return db.prepare(sql).all(params)
  } finally {
    if (own) db.close()
  }
}
