// Retriever bm25 : index FTS5 SQLite reconstruit depuis le seul corpus (vue dérivée).
// Interface contractuelle : { name, index(events), search(query) -> hits {eventId, score} }.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { loadCorpus } from '../corpus.js'
import { corpusPaths } from '../paths.js'

export const name = 'bm25'

export function index (root = corpusPaths().root, indexPath) {
  const { paths, events, sessions } = loadCorpus(root)
  const dbFile = indexPath || paths.index
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true }) // index jetable : rebuild propre et idempotent

  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE events(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT, agent TEXT, repo TEXT, model TEXT, cmd TEXT, text TEXT
    );
    CREATE VIRTUAL TABLE events_fts USING fts5(text, cmd, content='events', content_rowid='rowid');
  `)

  const ins = db.prepare('INSERT INTO events (id, session_id, ts, role, agent, repo, model, cmd, text) VALUES (?,?,?,?,?,?,?,?,?)')
  const tx = db.transaction(() => {
    for (const e of events) {
      const cmds = (e.toolCalls || []).map(c => c.cmd).filter(Boolean).join('\n')
      const model = e.model && (e.model.providerID || e.model.modelID)
        ? `${e.model.providerID || ''}/${e.model.modelID || ''}`
        : null
      ins.run(e.id, e.sessionId, e.ts, e.role, e.agent, e.repo, model, cmds || null, e.text ?? '')
    }
    // Titres de sessions (décision 17/09, motivée par l'éval) : une ligne synthétique
    // par session (id = id de session, role 'title') — les titres générés par la
    // source sont des résumés et constituent un signal de rappel fort.
    for (const s of sessions) {
      if (!s.title) continue
      ins.run(s.id, s.id, s.tsCreated ?? s.tsUpdated ?? 0, 'title', null, s.repo, null, null, s.title)
    }
  })
  tx()
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`)
  db.close()
  return { events: events.length, dbFile }
}

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
 * search(indexPath, { q, repo, session, after, before, model, role, agent, limit })
 * → hits ordonnés par rang BM25 (croissant = meilleur).
 */
export function search (indexPath, query) {
  const { q, repo, session, after, before, model, role, agent, limit = 20 } = query
  // OR pondéré BM25 (décision 17/09, motivée par l'éval) : l'AND strict laissait
  // gagner un message « fourre-tout » (config dump contenant tous les termes) contre
  // la vraie réponse ; la disjonction pondérée par IDF est le standard — un événement
  // matchant tous les termes cumule les poids et sort naturellement en tête.
  const match = ftsQuery(q, 'OR')
  // snippet col0 = text, col1 = cmd. Marqueurs ANSI par défaut (TUI), neutres si plain.
  const open = query.plain ? '»' : '\x1b[1;33m'
  const close = query.plain ? '«' : '\x1b[0m'
  const db = new Database(indexPath, { readonly: true, fileMustExist: true })
  try {
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
    db.close()
  }
}
