// Identité de génération PUBLIÉE (sous-lot M3a) : jeton aléatoire persisté dans la
// vue, renouvelé par les producteurs CLI à chaque transaction de publication, lu
// par `openReadSnapshot` et lié aux watermarks par source. Fixtures 100 %
// synthétiques ; la source pi reste sous le tmp du test.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest, fingerprint } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import { viewPath, GENERATION_KEY } from '../src/view.js'
import { openReadSnapshot, appErrorPayload, createStatusHandler } from '../src/mcp/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-gen-'))
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HEX64 = /^[0-9a-f]{64}$/

let seq = 0
const piAbsent = process.env.SESSION_DIG_PI_DIR

function addSourceMessage (dbFile, { sesId, msgId, text, ts }) {
  const db = new Database(dbFile)
  try {
    db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run(sesId, 'p', `/root/${sesId}`, sesId, ts, ts)
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(msgId, sesId, ts, ts, JSON.stringify({ role: 'user', agent: 'build' }))
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
  } finally { db.close() }
}

async function freshCorpus ({ withPi = false } = {}) {
  const dir = path.join(tmp, `c-${++seq}`)
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'fixture.db')
  const root = path.join(dir, 'corpus')
  buildFixtureDb(dbPath)
  let piDir = null
  if (withPi) {
    piDir = path.join(dir, 'pi-un')
    const uuid = fakeUuid()
    writePiSession(piDir, 'proj-a', 'ses_pi.jsonl', [
      sessionLine(uuid, T0, '/root/pi-un'),
      infoLine(T0 + 10, 'Titre Pi', 'inf'),
      messageLine(T0 + 1000, { role: 'user', content: [{ type: 'text', text: 'messagepigenere' }], timestamp: T0 + 1000 })
    ])
  }
  await ingest({ root, db: dbPath, ...(piDir ? { piDir } : {}), source: piDir ? 'all' : 'opencode' })
  index(root)
  return {
    dir,
    root,
    dbPath,
    piDir,
    vp: viewPath(root),
    cfg: { root, sources: { opencode: { path: dbPath }, pi: { path: piDir ?? piAbsent } } }
  }
}

function readGeneration (vp) {
  const db = new Database(vp, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_KEY)
    return row ? row.value : null
  } finally { db.close() }
}

function expectUnavailable (fn, reason) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    const payload = appErrorPayload(e)
    assert.equal(payload.code, 'view_unavailable', e.message)
    if (reason != null) assert.equal(payload.reason, reason)
    assert.ok(!JSON.stringify(payload).includes(tmp), 'aucun chemin local dans l’erreur')
    return payload
  }
}

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ── Identité initiale, persistance, lecture seule ───────────────────────────

test('identité initiale : génération persistée, hash stable, lecture SANS écriture', () => {
  return freshCorpus().then((r) => {
    const g0 = readGeneration(r.vp)
    assert.match(g0, /^[0-9a-f]{32}$/, 'génération = 128 bits hex')

    const a = openReadSnapshot(r.cfg, ({ generation, readIdentity }) => ({ generation, readIdentity }))
    const b = openReadSnapshot(r.cfg, () => 'ok')
    assert.equal(a.data.generation, g0)
    assert.equal(b.generation, g0, 'génération persistée entre lectures')
    assert.equal(a.data.readIdentity, b.readIdentity, 'hash stable pour le même état')
    assert.match(b.readIdentity, HEX64)
    assert.equal(readGeneration(r.vp), g0, 'openReadSnapshot n’écrit PAS la vue')

    // La génération n’est PAS présentée via indexMtime ni dans les sorties.
    assert.equal(typeof b.freshness.indexMtime, 'number')
    assert.notEqual(b.generation, String(b.freshness.indexMtime))
    const st = createStatusHandler(r.cfg)({}, [])
    assert.ok(!JSON.stringify(st).includes(g0), 'generation absente des sorties contractuelles')
    assert.equal(Object.hasOwn(st.freshness, 'generation'), false)
  })
})

// ── Producteurs : ingest delta, ingest noop, rebuild ────────────────────────

test('ingest avec VRAI delta : nouvelle génération publiée', async () => {
  const r = await freshCorpus()
  const g0 = readGeneration(r.vp)
  const id0 = openReadSnapshot(r.cfg, () => 'ok').readIdentity
  addSourceMessage(r.dbPath, { sesId: 'ses_delta', msgId: 'msg_delta', text: 'deltagenere', ts: T0 + 500000 })
  await ingest({ root: r.root, db: r.dbPath, source: 'opencode' })
  const g1 = readGeneration(r.vp)
  const id1 = openReadSnapshot(r.cfg, () => 'ok').readIdentity
  assert.notEqual(g1, g0)
  assert.notEqual(id1, id0)
})

test('ingest NOOP (aucun delta) : publication renouvelle quand même la génération', async () => {
  const r = await freshCorpus()
  const g0 = readGeneration(r.vp)
  const id0 = openReadSnapshot(r.cfg, () => 'ok').readIdentity
  await ingest({ root: r.root, db: r.dbPath, source: 'opencode' })
  const g1 = readGeneration(r.vp)
  assert.notEqual(g1, g0, 'génération non dérivée du contenu : renouvelée par la publication')
  assert.notEqual(openReadSnapshot(r.cfg, () => 'ok').readIdentity, id0)
})

test('rebuild (buildView/index) : génération changée même corpus/watermarks identiques, archive inchangée', async () => {
  const r = await freshCorpus()
  const g0 = readGeneration(r.vp)
  const fp0 = fingerprint(r.root).fingerprint
  index(r.root)
  const g1 = readGeneration(r.vp)
  assert.notEqual(g1, g0, 'rebuild change l’identité de génération')
  assert.equal(fingerprint(r.root).fingerprint, fp0, 'archive (hors vue dérivée) inchangée')
})

// ── Rollback ────────────────────────────────────────────────────────────────

test('rollback : une publication avortée conserve la génération précédente', async () => {
  const r = await freshCorpus()
  const g0 = readGeneration(r.vp)
  const realExec = Database.prototype.exec
  Database.prototype.exec = function (sql, ...rest) {
    if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') {
      const e = new Error('injection : échec de COMMIT'); e.code = 'EIO'; throw e
    }
    return realExec.call(this, sql, ...rest)
  }
  try {
    await assert.rejects(() => ingest({ root: r.root, db: r.dbPath, source: 'opencode' }))
  } finally { Database.prototype.exec = realExec }
  assert.equal(readGeneration(r.vp), g0, 'génération précédente conservée après rollback')
  assert.equal(openReadSnapshot(r.cfg, () => 'ok').data, 'ok', 'vue toujours lisible')
})

// ── Changement en plein read ────────────────────────────────────────────────

test('changement de génération pendant la lecture (autre connexion) => changed_publication', async () => {
  const r = await freshCorpus()
  expectUnavailable(() => openReadSnapshot(r.cfg, () => {
    const w = new Database(r.vp)
    try {
      w.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(GENERATION_KEY, 'deadbeefdeadbeefdeadbeefdeadbeef')
    } finally { w.close() }
    return 'x'
  }), 'changed_publication')
})

test('multiprocessus WAL : publication concurrente (génération+watermark) pendant le read => changed_publication', async () => {
  const r = await freshCorpus()
  const childScript = `
const Database = require('better-sqlite3')
const db = new Database(${JSON.stringify(r.vp)})
db.exec('BEGIN')
db.prepare("UPDATE watermark SET message = message + 1000, session = session + 1000 WHERE source = 'opencode'").run()
db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('generation', 'child-generation')").run()
db.exec('COMMIT')
db.close()
`
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  expectUnavailable(() => openReadSnapshot(r.cfg, ({ generation }) => {
    assert.match(generation, /^[0-9a-f]{32}$/)
    const res = spawnSync(process.execPath, ['-e', childScript], { cwd: repoRoot, env, encoding: 'utf8', timeout: 20000 })
    assert.equal(res.status, 0, `writer enfant : ${res.stderr}`)
    assert.equal(res.stdout, '')
    return 'x'
  }), 'changed_publication')
  assert.equal(readGeneration(r.vp), 'child-generation')
})

// ── Compatibilité anciennes vues sans génération ────────────────────────────

test('vue ANCIENNE sans génération : compatible, generation null explicite, identité = watermarks', async () => {
  const r = await freshCorpus()
  const db = new Database(r.vp)
  try { db.prepare('DELETE FROM meta WHERE key = ?').run(GENERATION_KEY) } finally { db.close() }
  const a = openReadSnapshot(r.cfg, ({ generation, readIdentity }) => ({ generation, readIdentity }))
  const b = openReadSnapshot(r.cfg, () => 'ok')
  assert.equal(a.data.generation, null, 'generation indisponible = null explicite')
  assert.equal(b.generation, null)
  assert.match(a.data.readIdentity, HEX64, 'identité de lecture calculable depuis les watermarks seuls')
  assert.equal(a.data.readIdentity, b.readIdentity)
  // status et search continuent leur contrat courant.
  assert.ok(createStatusHandler(r.cfg)({}, []).counts.events > 0)
})

// ── Divergence pi / vue en avance opencode (règles existantes conservées) ───

test('divergence jeton pi toujours refusée ; vue opencode en avance toujours permise', async () => {
  const r = await freshCorpus({ withPi: true })
  const stPath = path.join(r.root, 'state.json')
  const st0 = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  // Vue opencode en avance : état reculé sous le watermark publié → lecture permise.
  st0.sources.opencode.message = (st0.sources.opencode.message ?? 0) - 1
  st0.sources.opencode.session = (st0.sources.opencode.session ?? 0) - 1
  fs.writeFileSync(stPath, JSON.stringify(st0, null, 2) + '\n')
  const ahead = openReadSnapshot(r.cfg, () => 'ok')
  assert.match(ahead.generation, /^[0-9a-f]{32}$/)
  // Divergence pi : jeton d'état différent du jeton publié → refus.
  const st1 = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  st1.sources.pi.token = st1.sources.pi.token === 'deadbeef' ? 'cafebabe' : 'deadbeef'
  fs.writeFileSync(stPath, JSON.stringify(st1, null, 2) + '\n')
  expectUnavailable(() => openReadSnapshot(r.cfg, () => 'x'), 'pi_divergence')
})

// ── Limite écrite : mutation hors protocole NON détectée ────────────────────

test('limite documentée : mutation SQL hors protocole (hors génération/watermark) non détectée', async () => {
  const r = await freshCorpus()
  const id0 = openReadSnapshot(r.cfg, () => 'ok').readIdentity
  const db = new Database(r.vp)
  try { db.prepare("UPDATE events SET text = text || ' MUTATION-MANUELLE' WHERE role != 'title'").run() } finally { db.close() }
  const id1 = openReadSnapshot(r.cfg, () => 'ok').readIdentity
  assert.equal(id1, id0, 'l’identité ne prétend pas couvrir une mutation hors protocole')
})
