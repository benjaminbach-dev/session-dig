// Vue dérivable SQLite (change scale-corpus) : chemin de lecture unique du CLI.
// L'index — aujourd'hui dédié à la recherche — s'étend en vue de lecture : JSON
// intégral par événement, métadonnées de sessions, références de preuves brutes,
// FTS5 inchangé. Elle porte en son sein le watermark du corpus auquel elle
// correspond, est maintenue incrémentalement pendant l'ingestion (dans la
// transaction de publication) et reste entièrement reconstruisable depuis le
// seul corpus (contrat d'index jetable inchangé).
//
// Lignes de titre : une ligne synthétique par session (id = id de session,
// role 'title') — décision du 17/09 motivée par l'éval, inchangée. Les compteurs
// de lecture (total, visible, maskedCount) excluent ces lignes (role != 'title').
// L'ordre de lecture d'une session est (ts, id) — celui du shard.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { corpusPaths } from './paths.js'
import { streamLines } from './util.js'
import { listShards, assertLayout } from './layout.js'

export const SCHEMA = `
  CREATE TABLE meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE sessions(
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    title TEXT, repo TEXT, tsCreated INTEGER, tsUpdated INTEGER,
    directory TEXT, cost REAL, parentSession TEXT
  );
  CREATE TABLE events(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    role TEXT, agent TEXT, repo TEXT, model TEXT, cmd TEXT, text TEXT,
    json TEXT NOT NULL
  );
  CREATE INDEX events_session_key ON events(session_id, ts, id);
  CREATE INDEX events_ts ON events(ts);
  CREATE VIRTUAL TABLE events_fts USING fts5(text, cmd, content='events', content_rowid='rowid');
  CREATE TABLE rawrefs(
    rawRef TEXT PRIMARY KEY,
    eventId TEXT, sessionId TEXT, ts INTEGER, role TEXT, tool TEXT, cmd TEXT
  );
  CREATE TABLE watermark(message INTEGER, session INTEGER);
`

export function viewPath (root = corpusPaths().root) {
  return path.join(root, 'index.db')
}

export function viewExists (root = corpusPaths().root) {
  return fs.existsSync(viewPath(root))
}

export function openViewWrite (root = corpusPaths().root, dbFile = viewPath(root)) {
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  return db
}

/** La vue existe-t-elle avec le schéma v2 complet ? */
export function viewHasSchema (db) {
  const hasMeta = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='meta'").get().n > 0
  if (!hasMeta) return false
  const cols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name)
  return cols.includes('json') && cols.includes('session_id')
}

/** La vue courante existe et porte le schéma v2 + un watermark + la bonne version. */
export function viewIsCurrent (root = corpusPaths().root) {
  const dbFile = viewPath(root)
  if (!fs.existsSync(dbFile)) return false
  let db
  try { db = new Database(dbFile, { readonly: true, fileMustExist: true }) } catch { return false }
  try {
    if (!viewHasSchema(db)) return false
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('layoutVersion')
    if (!row || Number(row.value) !== 2) return false
    return !!db.prepare('SELECT message, session FROM watermark').get()
  } catch {
    return false
  } finally {
    db.close()
  }
}

/**
 * Ouvre la vue en lecture et vérifie version + fraîcheur : refus explicite si
 * absente, de mauvaise version ou périmée (motif + instruction de réparation) —
 * jamais de données décalées rendues en silence.
 */
export function openView (root = corpusPaths().root, dbFile = viewPath(root)) {
  if (!fs.existsSync(dbFile)) {
    throw new Error(`vue dérivable absente : ${dbFile} — lancer \`sdig refresh\` pour la construire depuis le corpus`)
  }
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  if (!viewHasSchema(db)) {
    db.close()
    throw new Error('vue de version antérieure (index v0) — reconstruire avec `sdig refresh`')
  }
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('layoutVersion')
  const got = row ? Number(row.value) : 1
  if (got !== 2) {
    db.close()
    throw new Error(`vue de layout non support : lu v${got}, attendu v2 — reconstruire avec \`sdig refresh\``)
  }
  const wm = db.prepare('SELECT message, session FROM watermark').get()
  if (!wm) {
    db.close()
    throw new Error('vue sans watermark — reconstruire avec `sdig refresh`')
  }
  const fresh = checkFresh(root, { db })
  if (!fresh.fresh) {
    db.close()
    throw new Error(fresh.reason)
  }
  return db
}

/**
 * Fraîcheur : la vue porte le watermark du corpus auquel elle correspond.
 * Limite écrite : le watermark couvre le chemin d'ingestion documenté — une
 * modification hors ingestion (shard édité à la main, watermark inchangé) n'est
 * pas détectée ici ; l'outil de détection est l'empreinte du corpus
 * (`sdig fingerprint`), pas le watermark.
 */
export function checkFresh (root = corpusPaths().root, { db = null } = {}) {
  const own = db == null
  const v = db ?? openView(root)
  try {
    const wm = v.prepare('SELECT message, session FROM watermark').get()
    if (!wm) return { fresh: false, reason: 'vue sans watermark — reconstruire avec `sdig refresh`' }
    const stPath = corpusPaths(root).state
    let st = {}
    try { st = JSON.parse(fs.readFileSync(stPath, 'utf8')) } catch {
      return { fresh: false, reason: 'corpus sans state.json lisible — relancer une ingestion' }
    }
    if ((st.message ?? -1) > wm.message || (st.session ?? -1) > wm.session) {
      return {
        fresh: false,
        reason: `vue en retard sur le corpus (vue message=${wm.message}/session=${wm.session}, corpus message=${st.message}/session=${st.session}) — lancer \`sdig refresh\``
      }
    }
    return { fresh: true, watermark: wm }
  } finally {
    if (own) v.close()
  }
}

/** Colonnes indexables d'un événement (partagées maintenance incrémentale / build). */
export function eventCols (e) {
  const cmds = (e.toolCalls || []).map(c => c.cmd).filter(Boolean).join('\n')
  const model = e.model && (e.model.providerID || e.model.modelID)
    ? `${e.model.providerID || ''}/${e.model.modelID || ''}`
    : null
  return { cmds: cmds || null, model }
}

/**
 * Rebuild complet de la vue depuis le seul corpus (référence de réparation).
 * En flux (jamais le corpus entier en RAM) ; déterministe ; FTS5 inchangé
 * ('rebuild' externe sur le contenu, comme l'index v0). Retourne { events, dbFile }.
 * Tolère un état absent (corpus de test brut) : watermark (-1, -1).
 * Repli v1 : sans shards, lit events.jsonl (corpus de test / pré-migration).
 */
export function buildView (root = corpusPaths().root, { dbFile = viewPath(root) } = {}) {
  const paths = corpusPaths(root)
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true })
  const db = openViewWrite(root, dbFile)
  try {
    db.exec(SCHEMA)
    let state = {}
    try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')) } catch { state = {} }
    if (state.layoutVersion != null) assertLayout(state)

    const insSes = db.prepare('INSERT INTO sessions (id, json, title, repo, tsCreated, tsUpdated, directory, cost, parentSession) VALUES (?,?,?,?,?,?,?,?,?)')
    const insEv = db.prepare('INSERT INTO events (id, session_id, ts, role, agent, repo, model, cmd, text, json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    const insRef = db.prepare('INSERT OR REPLACE INTO rawrefs (rawRef, eventId, sessionId, ts, role, tool, cmd) VALUES (?,?,?,?,?,?,?)')

    const insertEvent = (e, jsonLine) => {
      const { cmds, model } = eventCols(e)
      insEv.run(e.id, e.sessionId, e.ts, e.role ?? null, e.agent ?? null, e.repo ?? null, model, cmds, e.text ?? '', jsonLine)
      for (const c of e.toolCalls || []) {
        if (c.rawRef) insRef.run(String(c.rawRef), e.id, e.sessionId, e.ts, e.role ?? null, c.tool ?? null, c.cmd ?? null)
      }
    }

    streamLines(paths.sessions, (line) => {
      const s = JSON.parse(line)
      insSes.run(s.id, line, s.title ?? null, s.repo ?? null, s.tsCreated ?? null, s.tsUpdated ?? null, s.directory ?? null, s.cost ?? null, s.parentSession ?? null)
      // ligne de titre synthétique (décision 17/09) : role 'title', jamais comptée
      if (s.title) {
        insertEvent({
          id: s.id, sessionId: s.id, ts: s.tsCreated ?? s.tsUpdated ?? 0, role: 'title',
          repo: s.repo ?? null, text: s.title
        }, JSON.stringify({ schemaVersion: 1, id: s.id, sessionId: s.id, ts: s.tsCreated ?? s.tsUpdated ?? 0, role: 'title', text: s.title, repo: s.repo ?? null }))
      }
    })

    let count = 0
    const shards = listShards(root)
    const insertAll = db.transaction(() => {
      if (shards.length) {
        for (const rel of shards) {
          streamLines(path.join(root, rel), (line) => { insertEvent(JSON.parse(line), line); count++ })
        }
      } else if (fs.existsSync(paths.events)) {
        // corpus v1 (tests / pré-migration) : flux sur le fichier unique
        streamLines(paths.events, (line) => { insertEvent(JSON.parse(line), line); count++ })
      }
    })
    insertAll()

    const rebuildFts = () => db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`)
    rebuildFts()

    db.transaction(() => {
      db.prepare('INSERT INTO meta (key, value) VALUES (?,?)').run('layoutVersion', '2')
      db.prepare('INSERT INTO watermark (message, session) VALUES (?,?)').run(state.message ?? -1, state.session ?? -1)
    })()
    db.pragma('wal_checkpoint(TRUNCATE)')
    return { events: count, dbFile }
  } finally {
    db.close()
  }
}

export { assertLayout }
