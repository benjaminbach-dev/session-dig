// Retriever bm25 : index FTS5 SQLite reconstruit depuis le seul corpus (vue dérivée).
// Interface contractuelle : { name, index(events), search(query) -> hits {eventId, score} }.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { loadCorpus } from '../corpus.js'
import { corpusPaths } from '../paths.js'

export const name = 'bm25'

export function index (root = corpusPaths().root, indexPath) {
  const { paths, events } = loadCorpus(root)
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
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      const cmds = (e.toolCalls || []).map(c => c.cmd).filter(Boolean).join('\n')
      const model = e.model && (e.model.providerID || e.model.modelID)
        ? `${e.model.providerID || ''}/${e.model.modelID || ''}`
        : null
      ins.run(e.id, e.sessionId, e.ts, e.role, e.agent, e.repo, model, cmds || null, e.text ?? '')
    }
  })
  tx(events)
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`)
  db.close()
  return { events: events.length, dbFile }
}

function ftsQuery (q, joiner = 'AND') {
  const toks = (q.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || []).map(t => `"${t.replaceAll('"', '')}"`)
  if (!toks.length) throw new Error('requête vide ou sans termes exploitables')
  return toks.join(` ${joiner} `)
}

/**
 * search(indexPath, { q, repo, session, after, before, model, role, agent, limit })
 * → hits ordonnés par rang BM25 (croissant = meilleur).
 */
export function search (indexPath, query) {
  const { q, repo, session, after, before, model, role, agent, limit = 20 } = query
  // AND strict d'abord ; si aucun hit avec plusieurs termes, repli OR (décision 16/09 :
  // « bug proxy 461 » ne doit pas retourner vide quand les termes sont dispersés).
  const attempts = []
  const and = ftsQuery(q, 'AND')
  attempts.push(and)
  if (and.includes(' AND ')) attempts.push(ftsQuery(q, 'OR'))
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
      SELECT e.id, e.session_id, e.ts, e.role, e.agent, e.repo, e.model, e.cmd,
             snippet(events_fts, 0, @open, @close, '…', 14) AS snip,
             snippet(events_fts, 1, @open, @close, '…', 14) AS snipCmd,
             rank AS score
      FROM events e JOIN events_fts ON e.rowid = events_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT @limit`

    let hits = []
    for (const match of attempts) {
      const params = { match, limit, open, close }
      for (const k of Object.keys(base)) if (base[k] != null) params[k] = typeof base[k] === 'string' ? (k === 'session' ? `${base[k]}%` : (k === 'model' ? `%${base[k]}%` : base[k])) : base[k]
      hits = db.prepare(sql).all(params)
      if (hits.length) break
    }
    return hits
  } finally {
    db.close()
  }
}
