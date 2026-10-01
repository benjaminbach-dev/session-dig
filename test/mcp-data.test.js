// Accès lecture seule à la vue publiée + snapshot + fraîcheur (lot data M1).
// Fixtures 100 % synthétiques ; la source pi est TOUJOURS sous le tmp du test
// (jamais ~/.pi). Aucun handler métier, aucun serveur réseau.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import { viewPath } from '../src/view.js'
import { md5File } from '../src/util.js'
import { openReadSnapshot, appErrorPayload, viewUnavailable } from '../src/mcp/index.js'

const SECRET = 'sk-live-SUPER-SECRET-42'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-data-'))
// Hermétique : le chemin pi par défaut ne doit JAMAIS tomber sur ~/.pi.
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const rootPi = path.join(tmp, 'corpus-pi')
const piDir = path.join(tmp, 'pi-un')
const piAbsent = process.env.SESSION_DIG_PI_DIR
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const statePathOf = (r) => path.join(r, 'state.json')
const viewPathOf = (r) => viewPath(r)
const readState = (r) => JSON.parse(fs.readFileSync(statePathOf(r), 'utf8'))
const writeState = (r, st) => fs.writeFileSync(statePathOf(r), JSON.stringify(st, null, 2) + '\n')

function watermarkOf (r) {
  const db = new Database(viewPathOf(r), { readonly: true, fileMustExist: true })
  try { return db.prepare('SELECT source, token, message, session FROM watermark').all() } finally { db.close() }
}

function copyCorpus (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  fs.copyFileSync(viewPathOf(src), viewPathOf(dst))
  fs.copyFileSync(statePathOf(src), statePathOf(dst))
  for (const sub of ['events', 'raw']) {
    const from = path.join(src, sub)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dst, sub), { recursive: true })
  }
  const sessions = path.join(src, 'sessions.jsonl')
  if (fs.existsSync(sessions)) fs.copyFileSync(sessions, path.join(dst, 'sessions.jsonl'))
}

let copySeq = 0
function copyRoot (src) { const dst = path.join(tmp, `copie-${++copySeq}`); copyCorpus(src, dst); return dst }

function expectUnavailable (fn, reason) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    assert.equal(e.name, 'McpAppError')
    assert.equal(e.code, 'view_unavailable', e.message)
    assert.equal(e.reason, reason)
    assert.equal(appErrorPayload(e).reason, reason)
  }
}

function expectInternal (fn, reason) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    assert.equal(e.name, 'McpAppError')
    assert.equal(e.code, 'internal', e.message)
    assert.equal(e.reason, reason)
  }
}

const cfg = (r, sources = {}) => ({ root: r, sources: { opencode: { path: dbPath }, pi: { path: piAbsent }, ...sources } })

before(async () => {
  buildFixtureDb(dbPath)
  await ingest({ root, db: dbPath, source: 'opencode' })
  index(root)
  // Corpus mixte (opencode + pi synthétique explicite)
  const uuid = fakeUuid()
  writePiSession(piDir, 'proj-a', 'ses_a.jsonl', [
    sessionLine(uuid, T0, '/root/proj-a'),
    infoLine(T0 + 10, 'Requête pi data', 'infa'),
    messageLine(T0 + 1000, { role: 'user', content: [{ type: 'text', text: 'message pi synthétique' }], timestamp: T0 + 100 }),
    messageLine(T0 + 2000, { role: 'assistant', content: [{ type: 'text', text: 'réponse pi synthétique' }], provider: 'antho', model: 'sonnet-x', timestamp: T0 + 1500 })
  ])
  await ingest({ root: rootPi, db: dbPath, piDir, source: 'all' })
  index(rootPi)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ── Snapshot nominal et fraîcheur ───────────────────────────────────────────

test('snapshot : lecture dans un seul snapshot, freshness sans chemin, availability par stat', () => {
  const result = openReadSnapshot(cfg(root), ({ view, freshness, availability }) => {
    const n = view.get("SELECT COUNT(*) n FROM events WHERE role != 'title'").n
    const ses = view.all('SELECT id FROM sessions')
    assert.ok(n > 0)
    assert.equal(typeof freshness.sources.opencode.message, 'number')
    return { n, sessions: ses.length }
  })
  assert.ok(result.data.n > 0)
  assert.equal(result.freshness.corpusVersion, 2)
  assert.ok(Number.isFinite(result.freshness.indexMtime))
  assert.deepEqual(result.freshness.sources.opencode.session, readState(root).sources.opencode.session)
  assert.deepEqual(result.availability, { opencode: true, pi: false })
  // aucun chemin local ni nom interne ne fuit
  assert.ok(!JSON.stringify(result).includes(root))
  assert.ok(!JSON.stringify(result).includes('events/'))
})

test('view en avance sur l’état (COMMIT avant state.json, opencode) reste lisible', () => {
  const r = copyRoot(root)
  const wm = watermarkOf(r).find((x) => x.source === 'opencode')
  const st = readState(r)
  st.sources.opencode.message = wm.message - 1
  st.sources.opencode.session = wm.session - 1
  writeState(r, st)
  const result = openReadSnapshot(cfg(r), () => 'ok')
  assert.equal(result.data, 'ok')
})

test('state en avance (vue en retard, opencode) => stale_view', () => {
  const r = copyRoot(root)
  const wm = watermarkOf(r).find((x) => x.source === 'opencode')
  const st = readState(r)
  st.sources.opencode.message = wm.message + 1000
  writeState(r, st)
  expectUnavailable(() => openReadSnapshot(cfg(r), () => 'x'), 'stale_view')
})

test('state absent / JSON invalide / layout legacy => missing_state ou invalid_schema', () => {
  const missing = copyRoot(root)
  fs.rmSync(statePathOf(missing))
  expectUnavailable(() => openReadSnapshot(cfg(missing), () => 'x'), 'missing_state')

  const bad = copyRoot(root)
  fs.writeFileSync(statePathOf(bad), '{"sources":')
  expectUnavailable(() => openReadSnapshot(cfg(bad), () => 'x'), 'invalid_schema')

  const legacy = copyRoot(root)
  writeState(legacy, { layoutVersion: 1, sources: {} })
  expectUnavailable(() => openReadSnapshot(cfg(legacy), () => 'x'), 'invalid_schema')
})

test('freshness : sentinel opencode -1 => null (jamais un faux timestamp)', () => {
  const r = copyRoot(root)
  const vdb = new Database(viewPathOf(r))
  vdb.prepare("UPDATE watermark SET message = -1, session = -1 WHERE source = 'opencode'").run()
  vdb.close()
  const st = readState(r)
  st.sources.opencode.message = -1
  st.sources.opencode.session = -1
  writeState(r, st)
  const result = openReadSnapshot(cfg(r), () => 'ok')
  assert.equal(result.freshness.sources.opencode.message, null)
  assert.equal(result.freshness.sources.opencode.session, null)
})

test('freshness : pi token connu mais files absent => files null (pas 0 inventé)', () => {
  const r = copyRoot(rootPi)
  const st = readState(r)
  delete st.sources.pi.files
  writeState(r, st)
  const result = openReadSnapshot(cfg(r, { pi: { path: piDir } }), () => 'ok')
  assert.equal(result.freshness.sources.pi.files, null)
  assert.equal(typeof result.freshness.sources.pi.token, 'string')
})

test('état malformé : sources tableau ou pi.files tableau => invalid_schema', () => {
  const a = copyRoot(root)
  const stA = readState(a)
  stA.sources = []
  writeState(a, stA)
  expectUnavailable(() => openReadSnapshot(cfg(a), () => 'x'), 'invalid_schema')
  const b = copyRoot(rootPi)
  const stB = readState(b)
  stB.sources.pi.files = []
  writeState(b, stB)
  expectUnavailable(() => openReadSnapshot(cfg(b, { pi: { path: piDir } }), () => 'x'), 'invalid_schema')
})

test('état plat hérité (layoutVersion 2, sans sources) reste accepté', () => {
  const r = copyRoot(root)
  const oc = readState(r).sources.opencode
  writeState(r, { layoutVersion: 2, source: 'opencode', message: oc.message, session: oc.session })
  const result = openReadSnapshot(cfg(r), () => 'ok')
  assert.equal(result.data, 'ok')
  assert.equal(typeof result.freshness.sources.opencode.message, 'number')
})

test('vue absente / schéma invalide / layout ≠ 2 => missing_view ou invalid_schema', () => {
  const empty = path.join(tmp, 'racine-vide')
  fs.mkdirSync(empty, { recursive: true })
  expectUnavailable(() => openReadSnapshot(cfg(empty), () => 'x'), 'missing_view')

  const notDb = path.join(tmp, 'pas-une-base')
  fs.mkdirSync(notDb, { recursive: true })
  fs.writeFileSync(viewPathOf(notDb), 'not a database')
  expectUnavailable(() => openReadSnapshot(cfg(notDb), () => 'x'), 'invalid_schema')

  const legacy = copyRoot(root)
  const db = new Database(viewPathOf(legacy))
  db.prepare("UPDATE meta SET value='1' WHERE key='layoutVersion'").run()
  db.close()
  expectUnavailable(() => openReadSnapshot(cfg(legacy), () => 'x'), 'invalid_schema')
})

test('divergence jeton pi => pi_divergence (jamais comparaison d’ordre)', () => {
  const r = copyRoot(rootPi)
  const wm = watermarkOf(r).find((x) => x.source === 'pi')
  const st = readState(r)
  st.sources.pi.token = wm.token === 'deadbeef' ? 'cafebabe' : 'deadbeef'
  writeState(r, st)
  expectUnavailable(() => openReadSnapshot(cfg(r, { pi: { path: piDir } }), () => 'x'), 'pi_divergence')
})

test('vue en avance sur la source pi (jeton absent de l’état) => pi_divergence', () => {
  const r = copyRoot(rootPi)
  const st = readState(r)
  delete st.sources.pi
  writeState(r, st)
  expectUnavailable(() => openReadSnapshot(cfg(r), () => 'x'), 'pi_divergence')
})

test('source pi absente mais archivée : lecture permise, availability false', () => {
  const result = openReadSnapshot(cfg(rootPi, { pi: { path: path.join(tmp, 'pi-disparue') } }), ({ freshness, availability }) => {
    assert.ok(freshness.sources.pi)
    assert.equal(typeof freshness.sources.pi.files, 'number')
    return 'ok'
  })
  assert.equal(result.data, 'ok')
  assert.equal(result.availability.pi, false)
  assert.ok(!JSON.stringify(result).includes(piDir))
})

test('availability : type attendu par source (opencode fichier, pi répertoire)', () => {
  const dirAsOpencode = path.join(tmp, 'opencode-est-un-dossier')
  const fileAsPi = path.join(tmp, 'pi-est-un-fichier')
  fs.mkdirSync(dirAsOpencode, { recursive: true })
  fs.writeFileSync(fileAsPi, 'x')
  const result = openReadSnapshot(cfg(root, { opencode: { path: dirAsOpencode }, pi: { path: fileAsPi } }), () => 'ok')
  assert.deepEqual(result.availability, { opencode: false, pi: false })
})

test('availability : accès refusé (EACCES) => null, jamais false par défaut', () => {
  const piEacces = path.join(tmp, 'pi-eacces')
  const realStat = fs.statSync
  fs.statSync = function (p, ...a) {
    if (p === piEacces) { const e = new Error('refus'); e.code = 'EACCES'; throw e }
    return realStat.call(fs, p, ...a)
  }
  try {
    const result = openReadSnapshot(cfg(root, { pi: { path: piEacces } }), () => 'ok')
    assert.equal(result.availability.pi, null)
    assert.equal(result.availability.opencode, true)
  } finally { fs.statSync = realStat }
})

test('availability : noms de source inconnus jamais renvoyés ni recopiés', () => {
  const result = openReadSnapshot(cfg(root, { martien: { path: path.join(tmp, 'martien') } }), () => 'ok')
  assert.deepEqual(Object.keys(result.availability).sort(), ['opencode', 'pi'])
  assert.ok(!JSON.stringify(result).includes('martien'))
})

test('config sources invalide => invalid_config', () => {
  expectInternal(() => openReadSnapshot(cfg(root, { opencode: { path: 42 } }), () => 'x'), 'invalid_config')
  expectInternal(() => openReadSnapshot({ root, sources: { pi: {} } }, () => 'x'), 'invalid_config')
  expectInternal(() => openReadSnapshot({ root, sources: [] }, () => 'x'), 'invalid_config')
})

// ── État/Index modifiés pendant l’établissement ou la capture ──────

test('état republié pendant la capture (injection FS) => changed_publication', () => {
  const r = copyRoot(root)
  const sp = statePathOf(r)
  const realStat = fs.statSync
  let calls = 0
  fs.statSync = function (p, ...a) {
    const s = realStat.call(fs, p, ...a)
    if (p === sp) { calls++; if (calls % 2 === 0) return { dev: s.dev, ino: s.ino + 1, size: s.size, mtimeMs: s.mtimeMs } }
    return s
  }
  try { expectUnavailable(() => openReadSnapshot(cfg(r), () => 'x'), 'changed_publication') } finally { fs.statSync = realStat }
})

test('index remplacé pendant l’établissement du snapshot (injection FS) => changed_publication', () => {
  const r = copyRoot(root)
  const vpp = viewPathOf(r)
  const realStat = fs.statSync
  let calls = 0
  fs.statSync = function (p, ...a) {
    const s = realStat.call(fs, p, ...a)
    if (p === vpp) { calls++; if (calls === 2) return { dev: s.dev, ino: s.ino + 1, size: s.size, mtimeMs: s.mtimeMs } }
    return s
  }
  try { expectUnavailable(() => openReadSnapshot(cfg(r), () => 'x'), 'changed_publication') } finally { fs.statSync = realStat }
})

test('index VRAIMENT remplacé pendant la capture d’état finale => changed_publication', () => {
  const r = copyRoot(root)
  const vpp = viewPathOf(r)
  const sp = statePathOf(r)
  const realRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (p, ...a) {
    if (p === sp) {
      reads++
      if (reads === 3) { // 1 capture initiale, 2 pré-COMMIT, 3 post-COMMIT
        fs.copyFileSync(vpp, vpp + '.swap')
        fs.renameSync(vpp + '.swap', vpp)
      }
    }
    return realRead.call(fs, p, ...a)
  }
  try {
    expectUnavailable(() => openReadSnapshot(cfg(r), () => 'x'), 'changed_publication')
  } finally { fs.readFileSync = realRead }
})

// ── Concurrence et remplacement pendant le callback ─────────────────────────

test('COMMIT concurrent (autre connexion) pendant le callback => changed_publication', () => {
  const r = copyRoot(root)
  expectUnavailable(() => openReadSnapshot(cfg(r), () => {
    const w = new Database(viewPathOf(r))
    try { w.prepare("INSERT INTO meta(key, value) VALUES('probe-concurrent', '1')").run() } finally { w.close() }
    return 'x'
  }), 'changed_publication')
})

test('deux SELECT multiprocessus : writer enfant COMMIT pendant le callback (snapshot + data_version)', () => {
  const r = copyRoot(root)
  const vp = viewPathOf(r)
  const childScript = `
const Database = require('better-sqlite3')
const db = new Database(${JSON.stringify(vp)})
db.exec('BEGIN')
db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('probe-mp', '1')").run()
db.prepare("UPDATE watermark SET message = message + 1000, session = session + 1000 WHERE source = 'opencode'").run()
db.exec('COMMIT')
db.close()
`
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  expectUnavailable(() => openReadSnapshot(cfg(r), ({ view }) => {
    assert.equal(view.get("SELECT value FROM meta WHERE key = 'probe-mp'"), undefined)
    const res = spawnSync(process.execPath, ['-e', childScript], { cwd: repoRoot, env, encoding: 'utf8', timeout: 20000 })
    assert.equal(res.status, 0, `writer enfant : ${res.stderr}`)
    assert.equal(res.stdout, '')
    assert.equal(res.stderr, '')
    // Même transaction de lecture : le SELECT d'après voit toujours l'ancien snapshot.
    assert.equal(view.get("SELECT value FROM meta WHERE key = 'probe-mp'"), undefined)
    return 'x'
  }), 'changed_publication')
  // Lecture suivante : la publication est visible ; vue opencode en avance sur l'état = permis.
  const next = openReadSnapshot(cfg(r), ({ view, freshness }) => ({
    probe: view.get("SELECT value FROM meta WHERE key = 'probe-mp'")?.value ?? null,
    message: freshness.sources.opencode.message
  }))
  assert.equal(next.data.probe, '1')
  assert.equal(typeof next.data.message, 'number')
})

test('state.json publié pendant le callback => changed_publication', () => {
  const r = copyRoot(root)
  expectUnavailable(() => openReadSnapshot(cfg(r), () => {
    const st = readState(r)
    st.sources.opencode.message = (st.sources.opencode.message ?? 0) + 7
    writeState(r, st)
    return 'x'
  }), 'changed_publication')
})

test('index remplacé pendant le callback => changed_publication', () => {
  const r = copyRoot(root)
  expectUnavailable(() => openReadSnapshot(cfg(r), () => {
    fs.copyFileSync(viewPathOf(r), viewPathOf(r) + '.new')
    fs.renameSync(viewPathOf(r) + '.new', viewPathOf(r))
    return 'x'
  }), 'changed_publication')
})

// ── Callback : synchrone, erreurs bornées, façade lecture seule ─────────────

test('callback async/generator refusés AVANT appel (jamais invoqués)', () => {
  let asyncCalled = false
  const asyncCb = async () => { asyncCalled = true }
  expectInternal(() => openReadSnapshot(cfg(root), asyncCb), 'async_callback')
  assert.equal(asyncCalled, false)
  async function * asyncGen () { yield 1 }
  expectInternal(() => openReadSnapshot(cfg(root), asyncGen), 'async_callback')
  let genCalled = false
  function * gen () { genCalled = true; yield 1 }
  expectInternal(() => openReadSnapshot(cfg(root), gen), 'unsupported_callback')
  assert.equal(genCalled, false)
})

test('callback retournant une Promise : refusé, rejet natif neutralisé', async () => {
  let unhandled = null
  const onUnhandled = (e) => { unhandled = e }
  process.on('unhandledRejection', onUnhandled)
  try {
    expectInternal(() => openReadSnapshot(cfg(root), () => Promise.resolve('x')), 'async_callback')
    expectInternal(() => openReadSnapshot(cfg(root), () => Promise.reject(new Error('boom'))), 'async_callback')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(unhandled, null, 'aucune rejection non gérée')
    // la connexion est fermée : une lecture suivante fonctionne (pas de fuite)
    assert.equal(openReadSnapshot(cfg(root), () => 'ok').data, 'ok')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('exception du callback : internal bornée, aucun contenu recopié', () => {
  try {
    openReadSnapshot(cfg(root), () => { throw new Error(`boom ${SECRET}`) })
    assert.fail('devait refuser')
  } catch (e) {
    assert.equal(e.code, 'internal')
    assert.equal(e.reason, 'callback_failed')
    assert.ok(!JSON.stringify(appErrorPayload(e)).includes(SECRET))
  }
})

test('façade lecture seule : prepare non-SELECT refusé, SELECT autorisé', () => {
  const result = openReadSnapshot(cfg(root), ({ view }) => {
    let writeRejected = false
    try { view.prepare("INSERT INTO meta(key, value) VALUES('x', 'y')") } catch { writeRejected = true }
    let attachRejected = false
    try { view.prepare("ATTACH DATABASE 'autre.db' AS autre") } catch { attachRejected = true }
    const n = view.get("SELECT COUNT(*) n FROM meta WHERE key = 'x'").n
    return { writeRejected, attachRejected, n }
  })
  assert.equal(result.data.writeRejected, true)
  assert.equal(result.data.attachRejected, true)
  assert.equal(result.data.n, 0)
})

test('configuration invalide : root manquant ou callback non fonction => internal', () => {
  for (const bad of [() => openReadSnapshot({}, () => 'x'), () => openReadSnapshot(cfg(root), null)]) {
    try { bad(); assert.fail('devait refuser') } catch (e) {
      assert.equal(e.code, 'internal')
      assert.equal(e.reason, 'invalid_config')
    }
  }
})

test('raisons : ensemble fermé, jamais recopiées hors liste', () => {
  const ok = appErrorPayload(viewUnavailable('changed_publication'))
  assert.deepEqual(ok, { code: 'view_unavailable', message: 'vue indisponible', reason: 'changed_publication' })
  const mutated = viewUnavailable('changed_publication')
  mutated.reason = SECRET
  assert.ok(!JSON.stringify(appErrorPayload(mutated)).includes(SECRET))
  assert.throws(() => viewUnavailable('raison-inconnue'), /inconnue/)
})

// ── Aucune écriture / aucune lecture hors vue+état ──────────────────────────

test('WAL : annexes créées si absentes (index.db-shm/-wal), index.db principal inchangé', () => {
  const r = copyRoot(root)
  const before = new Set(fs.readdirSync(r))
  assert.ok(!before.has('index.db-shm') && !before.has('index.db-wal'))
  const coreBefore = md5File(viewPathOf(r))
  openReadSnapshot(cfg(r), () => 'ok')
  const added = fs.readdirSync(r).filter((f) => !before.has(f))
  assert.ok(added.every((f) => f === 'index.db-shm' || f === 'index.db-wal'), `annexes créées : ${added.join(', ')}`)
  assert.deepEqual(added.sort(), ['index.db-shm', 'index.db-wal'])
  assert.equal(md5File(viewPathOf(r)), coreBefore, 'index.db principal inchangé')
})

test('WAL : annexes préexistantes => aucune création supplémentaire', () => {
  const r = copyRoot(root)
  const vpp = viewPathOf(r)
  fs.writeFileSync(vpp + '-wal', '')
  fs.writeFileSync(vpp + '-shm', '')
  const before = new Set(fs.readdirSync(r))
  openReadSnapshot(cfg(r), () => 'ok')
  assert.deepEqual(fs.readdirSync(r).filter((f) => !before.has(f)), [])
})

test('journal mode de la vue = wal ; readonly refuse les écritures (pas une isolation générale)', () => {
  const db = new Database(viewPathOf(root), { readonly: true, fileMustExist: true })
  try {
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    assert.throws(() => db.prepare("INSERT INTO meta(key, value) VALUES('z', 'z')").run())
  } finally { db.close() }
})

test('empreintes : shards, sessions, state, index et base source inchangés', () => {
  const r = copyRoot(rootPi)
  const files = [
    ...fs.readdirSync(path.join(r, 'events'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => path.join(r, 'events', String(f))),
    path.join(r, 'sessions.jsonl'),
    statePathOf(r),
    viewPathOf(r),
    dbPath,
    path.join(piDir, 'proj-a', 'ses_a.jsonl')
  ]
  const before = new Map(files.map((f) => [f, md5File(f)]))
  openReadSnapshot(cfg(r, { pi: { path: piDir } }), () => 'ok')
  for (const [f, hash] of before) assert.equal(md5File(f), hash, `inchangé : ${path.relative(tmp, f)}`)
})

test('sans shards ni raw : le snapshot ne lit que la vue et l’état', () => {
  const r = copyRoot(root)
  fs.rmSync(path.join(r, 'events'), { recursive: true, force: true })
  fs.rmSync(path.join(r, 'raw'), { recursive: true, force: true })
  const result = openReadSnapshot(cfg(r), ({ view }) => view.get('SELECT COUNT(*) n FROM sessions').n)
  assert.ok(result.data >= 1)
})

test('aucun nom de fichier suivi pi ni sentinel de racine dans la sortie', () => {
  const r = copyRoot(rootPi)
  const result = openReadSnapshot(cfg(r, { pi: { path: piDir } }), () => 'ok')
  const json = JSON.stringify(result)
  assert.ok(!json.includes(rootPi))
  assert.ok(!json.includes('ses_a.jsonl'))
  assert.ok(!json.includes('proj-a'))
  assert.ok(!json.includes(SECRET))
})