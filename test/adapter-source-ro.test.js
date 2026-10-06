// Adaptateurs opencode : ouverture source en LECTURE SEULE STRICTE (aucune copie
// db/-wal/-shm), détection d'index de session par PRAGMA, pagination sans perte
// au-delà d'un lot, lecture d'une source WAL vivante sans modifier db/wal, et refus
// propre d'une source illisible sans état/COMMIT partiel. Fixtures 100 % synthétiques.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest } from '../src/corpus.js'
import { md5File } from '../src/util.js'
import { openReadonlySource } from '../src/adapter/source-db.js'
import { adaptPaged } from '../src/adapter/opencode-page.js'
import { adapt } from '../src/adapter/opencode.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-src-ro-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const SRC_SCHEMA = `
  CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT,
    time_created INTEGER, time_updated INTEGER, cost REAL DEFAULT 0,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0);
  CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
  CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
`

let seq = 0
function makeSource (count, indexSql = null) {
  const dbPath = path.join(tmp, `src-${seq++}.db`)
  const db = new Database(dbPath)
  try {
    db.exec(SRC_SCHEMA)
    const ins = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    const tx = db.transaction(() => {
      for (let i = 0; i < count; i++) ins.run(`ses_${String(i).padStart(5, '0')}`, `t${i}`, `/root/r${i}`, null, i, i, 0, 0, 0, 0, 0, 0)
    })
    tx()
    if (indexSql) db.exec(indexSql)
  } finally { db.close() }
  return dbPath
}

async function collectSessions (dbPath) {
  const sessions = []
  await adaptPaged(dbPath, {}, { batchSize: 2000 }, (b) => sessions.push(...b.sessions))
  return sessions
}

/** SQL de la requête de pagination des sessions, capturé via le prototype Statement. */
async function sessionSqlOf (fn) {
  const probe = new Database(':memory:')
  const proto = Object.getPrototypeOf(probe) // Database.prototype
  probe.close()
  const orig = proto.prepare
  const sqls = []
  proto.prepare = function (sql, ...a) { sqls.push(sql); return orig.call(this, sql, ...a) }
  try { await fn() } finally { proto.prepare = orig }
  return sqls.map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => /SELECT \* FROM session WHERE time_updated > \?/.test(s))[0] ?? null
}

const isIndexed = (sql) => /ORDER BY time_updated, id/.test(sql)
const isFallback = (sql) => /ORDER BY id/.test(sql)

// ── Ouverture RO stricte : absence / garbage / non-fichier ───────────────────

test('openReadonlySource : absence → erreur explicite (chemin + action)', () => {
  const missing = path.join(tmp, 'absent.db')
  assert.throws(() => openReadonlySource(missing), (e) => /base source introuvable/.test(e.message) && e.message.includes(missing))
})

test('openReadonlySource : fichier non-SQLite (garbage) → erreur explicite, connexion refermée, aucune copie', () => {
  const garbage = path.join(tmp, 'garbage.db')
  fs.writeFileSync(garbage, Buffer.from('ceci n\'est pas une base sqlite '.repeat(200)))
  const origCopy = fs.copyFileSync
  const origClose = Database.prototype.close
  const closed = []
  const before = md5File(garbage)
  fs.copyFileSync = () => { throw new Error('COPY_INTERDITE') }
  Database.prototype.close = function () { const result = origClose.call(this); closed.push(this); return result }
  try {
    assert.throws(() => openReadonlySource(garbage), (e) => /base source non lisible/.test(e.message) && e.message.includes(garbage))
    assert.equal(closed.length, 1, 'connexion invalide refermée explicitement')
    assert.equal(closed[0].open, false)
    assert.equal(md5File(garbage), before, 'source invalide inchangée')
  } finally { fs.copyFileSync = origCopy; Database.prototype.close = origClose }
})

test('openReadonlySource : chemin non-fichier (répertoire) → erreur explicite, aucune copie', () => {
  const dir = path.join(tmp, 'un-repertoire.db')
  fs.mkdirSync(dir, { recursive: true })
  const origCopy = fs.copyFileSync
  fs.copyFileSync = () => { throw new Error('COPY_INTERDITE') }
  try {
    assert.throws(() => openReadonlySource(dir), (e) => /base source illisible/.test(e.message) && e.message.includes(dir))
  } finally { fs.copyFileSync = origCopy }
})

test('adaptPaged : source garbage → refus explicite (jamais un demi-résultat)', async () => {
  const garbage = path.join(tmp, 'garbage2.db')
  fs.writeFileSync(garbage, Buffer.from('garbage'.repeat(500)))
  await assert.rejects(() => adaptPaged(garbage, {}, { batchSize: 2000 }, () => {}), /base source non lisible/)
})

test('adapt (ancienne API) : toujours fonctionnelle sur la source partagée', () => {
  const dbPath = makeSource(3)
  const r = adapt(dbPath, {})
  assert.equal(r.sessions.length, 3)
  assert.equal(r.events.length, 0)
})

// ── Détection d'index : PRAGMA (première colonne clé de la table SESSION) ────

test('détection index : vrai index (time_updated, id) → pagination keyset indexée', async () => {
  const dbPath = makeSource(10, 'CREATE INDEX idx_up ON session(time_updated, id)')
  const sql = await sessionSqlOf(() => collectSessions(dbPath))
  assert.ok(isIndexed(sql), `attendu keyset, obtenu : ${sql}`)
})

test('détection index : index sur MESSAGE seul → repli (faux positif écarté)', async () => {
  const dbPath = makeSource(10, 'CREATE INDEX idx_msg_up ON message(time_updated)')
  const sql = await sessionSqlOf(() => collectSessions(dbPath))
  assert.ok(isFallback(sql), `attendu repli, obtenu : ${sql}`)
})

test('détection index : colonne time_updated NON en tête → repli', async () => {
  const dbPath = makeSource(10, 'CREATE INDEX idx_nonlead ON session(id, time_updated)')
  const sql = await sessionSqlOf(() => collectSessions(dbPath))
  assert.ok(isFallback(sql), `attendu repli, obtenu : ${sql}`)
})

test('détection index : index PARTIEL → repli (ne couvre pas toute la table)', async () => {
  const dbPath = makeSource(10, 'CREATE INDEX idx_partial ON session(time_updated) WHERE time_updated > 0')
  const sql = await sessionSqlOf(() => collectSessions(dbPath))
  assert.ok(isFallback(sql), `attendu repli, obtenu : ${sql}`)
})

test('détection index : expression en tête puis time_updated → repli', async () => {
  const dbPath = makeSource(10, 'CREATE INDEX idx_expr ON session((time_updated + 0), time_updated)')
  const sql = await sessionSqlOf(() => collectSessions(dbPath))
  assert.ok(isFallback(sql), `attendu repli, obtenu : ${sql}`)
})

test('détection index : nom d’index contenant une quote → keyset correct', async () => {
  const dbPath = makeSource(10, 'CREATE INDEX "idx\'quote" ON session(time_updated, id)')
  const sql = await sessionSqlOf(() => collectSessions(dbPath))
  assert.ok(isIndexed(sql), `attendu keyset, obtenu : ${sql}`)
})

// ── Pagination > 2050 sessions : aucune perte (repli ET index réel) ──────────

test('pagination > 2050 sessions : repli sans index → aucune perte', async () => {
  const dbPath = makeSource(2100)
  const sessions = await collectSessions(dbPath)
  assert.equal(sessions.length, 2100)
  assert.equal(new Set(sessions.map(s => s.id)).size, 2100, 'aucun doublon')
})

test('pagination > 2050 sessions : index réel → aucune perte', async () => {
  const dbPath = makeSource(2100, 'CREATE INDEX idx_up ON session(time_updated, id)')
  const sessions = await collectSessions(dbPath)
  assert.equal(sessions.length, 2100)
  assert.equal(new Set(sessions.map(s => s.id)).size, 2100, 'aucun doublon')
})

// ── WAL vivant : lecture RO des données commitées, db/wal inchangés ──────────

test('adaptPaged : source WAL vivante lue en RO, octets db/wal inchangés', async () => {
  const dbPath = path.join(tmp, 'wal.db')
  const wdb = new Database(dbPath)
  try {
    wdb.pragma('journal_mode = WAL')
    wdb.exec(SRC_SCHEMA)
    const ins = wdb.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    const tx = wdb.transaction(() => {
      for (let i = 0; i < 7; i++) ins.run(`ses_wal_${i}`, `t${i}`, `/root/w${i}`, null, i, i, 0, 0, 0, 0, 0, 0)
    })
    tx()
    // Le writer reste OUVERT : le WAL n'est pas checkpointé.
    const walPath = `${dbPath}-wal`
    assert.ok(fs.existsSync(walPath), 'WAL présent pendant la lecture')
    const before = { db: md5File(dbPath), wal: md5File(walPath) }
    const sessions = []
    await adaptPaged(dbPath, {}, { batchSize: 2000 }, (b) => sessions.push(...b.sessions))
    assert.equal(sessions.length, 7, 'données commitées visibles en RO')
    const after = { db: md5File(dbPath), wal: md5File(walPath) }
    assert.deepEqual(after, before, 'db/wal non modifiés par la lecture RO')
  } finally { wdb.close() }
})

// ── Ingest : source illisible → aucun état/vue publiés, verrou libéré ────────

test('ingest : source illisible → refus, aucun state.json/index.db, verrou libéré', async () => {
  const root = path.join(tmp, 'corpus-garbage')
  const garbage = path.join(tmp, 'ingest-garbage.db')
  fs.writeFileSync(garbage, Buffer.from('pas une base'.repeat(300)))
  await assert.rejects(() => ingest({ root, db: garbage, source: 'opencode' }), /base source/)
  assert.equal(fs.existsSync(path.join(root, 'state.json')), false, 'aucun état publié')
  assert.equal(fs.existsSync(path.join(root, 'index.db')), false, 'aucune vue publiée')

  // Verrou libéré : une ingestion valide sur le MÊME corpus passe ensuite.
  const valid = path.join(tmp, 'ingest-valid.db')
  buildFixtureDb(valid)
  const r = await ingest({ root, db: valid, source: 'opencode' })
  assert.ok(r.totals.events > 0, 'ingestion valide après l’échec (verrou libéré)')
  assert.ok(fs.existsSync(path.join(root, 'state.json')))
})
