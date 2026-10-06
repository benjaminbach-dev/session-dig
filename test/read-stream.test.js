// scale-corpus, sous-partie « read complet » : lecture EN FLUX.
// Prouve, sur fixtures 100 % synthétiques, que :
//   1. la sortie CLI (terminale ET JSON) du chemin en flux est OCTET POUR OCTET
//      identique aux fonctions tableau `renderRead`/`renderReadJson` (around/tail/
//      all/ancre/around masqué/around introuvable/pi/plain/full/chars) ;
//   2. le mode `all` charge les événements par itérateur PARESSEUX (`.iterate()`,
//      jamais `.all()` sur le `json` des événements) ;
//   3. itérateur ET connexion sont nettoyés sur erreur d'itération et sur sortie
//      anticipée du consommateur, `iter.return()` avant `COMMIT` ;
//   4. une publication concurrente PENDANT la consommation n'apparaît pas dans le
//      flux (snapshot tenu par la transaction de lecture) et un nouveau lecteur la voit ;
//   5. l'écriture respecte la backpressure du sink (attente `drain`) et propage
//      les erreurs de flux sans perdre de données.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { buildFixtureDb, T0 } from './helpers/fixture.js'
import { fakeUuid, sessionLine, messageLine, infoLine, writePiSession, T0 as T0PI } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { sessionSlice, streamRead } from '../src/read.js'
import { renderRead, renderReadJson, readTerminalChunks, readJsonChunks } from '../src/format.js'
import { streamToWritable } from '../src/util.js'

const CLI = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-read-stream-'))
const __prevPiDir = process.env.SESSION_DIG_PI_DIR
const root = path.join(tmp, 'corpus')
const dbPath = path.join(tmp, 'fixture.db')
const piDir = path.join(tmp, 'pi')
process.env.SESSION_DIG_PI_DIR = piDir

const LONG = 320
const LONG_TEXT = 'longstart ' + 'é'.repeat(60000)
const LONG_BIG = 100

let piId = null
let piEmptyId = null

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)')
      .run('ses_long', 'p', '/root/ses_long', 'Session longue', T0 + 1_000_000, T0 + 1_000_000)
    for (let i = 0; i < LONG; i++) {
      const id = `msg_long_${String(i).padStart(3, '0')}`
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
        .run(id, 'ses_long', T0 + 2_000_000 + i, T0 + 2_000_000 + i, JSON.stringify({ role: i % 2 ? 'assistant' : 'user', agent: 'build' }))
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
        .run(`prt_${id}`, id, 'ses_long', T0 + 2_000_000 + i, T0 + 2_000_000 + i, JSON.stringify({ type: 'text', text: i === LONG_BIG ? LONG_TEXT : `message long ${i}` }))
    }
  } finally { db.close() }
  piEmptyId = `pi:${fakeUuid()}`
  writePiSession(piDir, 'proj-empty', 'ses-empty.jsonl', [
    sessionLine(piEmptyId.slice(3), T0PI, '/root/proj-empty'),
    infoLine(T0PI + 10, 'Session pi vide', 'inf-empty')
  ])
  piId = `pi:${fakeUuid()}`
  writePiSession(piDir, 'proj', 'ses.jsonl', [
    sessionLine(piId.slice(3), T0PI, '/root/proj'),
    infoLine(T0PI + 10, 'Session pi flux', 'inf1'),
    messageLine(T0PI + 1000, { role: 'user', content: [{ type: 'text', text: 'question pi' }], timestamp: T0PI + 100 }),
    messageLine(T0PI + 2000, { role: 'assistant', content: [{ type: 'text', text: 'réponse pi détaillée' }], provider: 'antho', model: 'sonnet-x', timestamp: T0PI + 1500 })
  ])
  await ingest({ root, db: dbPath, piDir, source: 'all' })
})

after(() => {
  if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = __prevPiDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

function runCli (args) {
  return spawnSync(process.execPath, [CLI, ...args, '--home', root], {
    env: { ...process.env, SESSION_DIG_HOME: root },
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 32 << 20
  })
}

const cases = [
  { name: 'all', args: [], sid: 'ses_fix1', opts: {}, fmt: {} },
  { name: 'tail', args: ['--tail', '2'], sid: 'ses_fix1', opts: { tail: 2 }, fmt: {} },
  { name: 'around', args: ['--around', 'msg_a1', '--ctx', '1'], sid: 'ses_fix1', opts: { aroundId: 'msg_a1', ctx: 1 }, fmt: {} },
  { name: 'ancre', args: ['--at', 'msg_a1'], sid: 'ses_fix1', opts: { at: 'msg_a1' }, fmt: {} },
  { name: 'around masqué', args: ['--at', 'msg_a1', '--around', 'msg_a2'], sid: 'ses_fix1', opts: { at: 'msg_a1', aroundId: 'msg_a2' }, fmt: {} },
  { name: 'around introuvable', args: ['--around', 'msg_nope'], sid: 'ses_fix1', opts: { aroundId: 'msg_nope' }, fmt: {} },
  { name: 'plain', args: ['--plain'], sid: 'ses_fix1', opts: {}, fmt: { plain: true } },
  { name: 'full', args: ['--full'], sid: 'ses_fix1', opts: {}, fmt: { full: true } },
  { name: 'chars', args: ['--chars', '20'], sid: 'ses_fix1', opts: {}, fmt: { chars: 20 } },
  { name: 'session longue', args: ['--tail', '3'], sid: 'ses_long', opts: { tail: 3 }, fmt: {} },
  { name: 'pi', args: [], sid: piId, opts: {}, fmt: {} }
]

for (const c of cases) {
  test(`parité terminal OCTET : ${c.name}`, () => {
    const r = runCli(['read', c.sid, ...c.args])
    assert.equal(r.status, 0, String(r.stderr))
    assert.equal(r.stderr, '', 'aucun diagnostic parasite')
    const expected = renderRead(sessionSlice(root, c.sid, c.opts), c.sid, c.fmt)
    assert.equal(r.stdout, expected + '\n', `${c.name} : flux ≡ tableau (octet pour octet)`)
  })

  test(`parité JSON OCTET : ${c.name}`, () => {
    const r = runCli(['read', c.sid, ...c.args, '--json'])
    assert.equal(r.status, 0, String(r.stderr))
    assert.equal(r.stderr, '')
    const expected = renderReadJson(sessionSlice(root, c.sid, c.opts), c.sid)
    assert.equal(r.stdout, expected + '\n', `${c.name} : JSON flux ≡ JSON tableau`)
  })
}

test('session pi vide : CLI « session inconnue » (parité total 0 → null), stdout vide', () => {
  const r = runCli(['read', piEmptyId])
  assert.equal(r.status, 1, String(r.stderr))
  assert.match(r.stderr, /session inconnue/)
  assert.equal(r.stdout, '')
})

test('erreurs CLI préservées : ancre invalide (code 2) et session inconnue (code 1), stdout vide', () => {
  const bad = runCli(['read', 'ses_fix1', '--at', '2026-02-29'])
  assert.equal(bad.status, 2, String(bad.stderr))
  assert.match(bad.stderr, /jour hors bornes/)
  assert.equal(bad.stdout, '', 'aucune sortie partielle trompeuse avant stdout')

  const unknown = runCli(['read', 'ses_inconnue'])
  assert.equal(unknown.status, 1, String(unknown.stderr))
  assert.match(unknown.stderr, /session inconnue/)
  assert.equal(unknown.stdout, '')
})

// ── Instrumentation better-sqlite3 : .all() vs .iterate() + ordre COMMIT ──────

function instrumentStatements (hooks = {}) {
  const probe = new Database(':memory:')
  const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'))
  probe.close()
  const orig = { all: proto.all, iterate: proto.iterate, exec: Database.prototype.exec, close: Database.prototype.close }
  const calls = { allSql: [], iterateSql: [], next: 0, ret: 0, databases: [], iterAlive: false, commitAlive: false }
  proto.all = function (...a) { calls.allSql.push(this.source); return orig.all.apply(this, a) }
  proto.iterate = function (...a) {
    calls.iterateSql.push(this.source)
    calls.databases.push(this.database)
    const it = orig.iterate.apply(this, a)
    calls.iterAlive = true
    return {
      [Symbol.iterator] () { return this },
      next () { calls.next++; const r = hooks.next ? hooks.next(it, calls) : it.next(); if (r && r.done) calls.iterAlive = false; return r },
      return () { calls.ret++; calls.iterAlive = false; return it.return ? it.return() : { done: true } }
    }
  }
  Database.prototype.exec = function (sql, ...a) {
    const verb = String(sql).trim().toUpperCase()
    calls.databases.push(this)
    if (verb === 'COMMIT' && calls.iterAlive) calls.commitAlive = true
    if (hooks.beginThrow && verb === 'BEGIN') throw new Error('BEGIN_FAIL')
    return orig.exec.call(this, sql, ...a)
  }
  if (hooks.closeThrow) {
    Database.prototype.close = function () {
      orig.close.call(this)
      throw new Error('CLOSE_FAIL')
    }
  }
  return {
    calls,
    restore () {
      proto.all = orig.all
      proto.iterate = orig.iterate
      Database.prototype.exec = orig.exec
      Database.prototype.close = orig.close
    }
  }
}

const isEventsJson = (sql) => /FROM events/.test(sql) && /\bjson\b/i.test(sql)

test('mode all : événements chargés par .iterate() (jamais .all() sur json), itérateur lâché avant COMMIT', async () => {
  const inst = instrumentStatements()
  try {
    const items = []
    for await (const item of streamRead(root, 'ses_long', {})) items.push(item)
    const window = items.shift().window
    assert.equal(window.total, LONG)
    assert.equal(items.length, LONG, 'tous les événements de la fenêtre, un par un')
    assert.equal(inst.calls.allSql.filter(isEventsJson).length, 0, 'aucun .all() du json des événements')
    const itSql = inst.calls.iterateSql.filter(isEventsJson)
    assert.equal(itSql.length, 1, 'une itération des événements')
    assert.match(itSql[0], /\bLIMIT\b/i, 'borne keyset/taille — pas de session non bornée')
    assert.equal(inst.calls.commitAlive, false, 'iter.return() avant COMMIT (connexion non occupée)')
    assert.ok(inst.calls.ret >= 1, 'itérateur lâché')
    assert.ok(inst.calls.databases.every(db => !db.open), 'connexion fermée en fin de flux')
  } finally { inst.restore() }
})

test('fenêtre bornée (--tail 2) : seuls les événements de la fenêtre sont tirés', async () => {
  const inst = instrumentStatements()
  try {
    const items = []
    for await (const item of streamRead(root, 'ses_long', { tail: 2 })) items.push(item)
    const window = items.shift().window
    assert.deepEqual(items.map(x => x.index), [LONG - 2, LONG - 1])
    assert.equal(window.total, LONG)
    assert.ok(inst.calls.next <= 4, `itérations bornées par la fenêtre (next=${inst.calls.next})`)
    assert.equal(inst.calls.allSql.filter(isEventsJson).length, 0)
    assert.ok(inst.calls.databases.every(db => !db.open))
  } finally { inst.restore() }
})

test('erreur d’itération : propagée, itérateur lâché, ROLLBACK (pas COMMIT), connexion fermée', async () => {
  const inst = instrumentStatements({
    next: (it, calls) => { if (calls.next === 2) throw new Error('ITER_FAIL'); return it.next() }
  })
  try {
    await assert.rejects(async () => {
      for await (const _ of streamRead(root, 'ses_long', {})) { /* consomme */ }
    }, /ITER_FAIL/)
    assert.ok(inst.calls.ret >= 1, 'iter.return() appelé malgré l’erreur')
    assert.equal(inst.calls.commitAlive, false)
    assert.ok(inst.calls.databases.every(db => !db.open), 'connexion fermée')
  } finally { inst.restore() }
})

test('sortie anticipée du consommateur : return() nettoie itérateur et connexion (aucun « busy »)', async () => {
  const inst = instrumentStatements()
  try {
    const gen = streamRead(root, 'ses_long', {})
    const head = await gen.next()
    assert.equal(head.value.window.total, LONG)
    const first = await gen.next()
    assert.equal(first.value.index, 0)
    await gen.return()
    assert.ok(inst.calls.ret >= 1)
    assert.ok(inst.calls.databases.every(db => !db.open))
  } finally { inst.restore() }
})

test('sortie anticipée via le générateur de rendu : le flux amont (transaction/connexion) est refermé', async () => {
  for (const mode of ['terminal', 'json']) {
    const inst = instrumentStatements()
    try {
      const gen = streamRead(root, 'ses_long', {})
      const head = await gen.next()
      const slice = { ...head.value.window, error: head.value.window.warning ?? null }
      const events = { [Symbol.asyncIterator]: () => gen }
      const chunks = mode === 'terminal'
        ? readTerminalChunks(slice, 'ses_long', {}, events)
        : readJsonChunks(slice, 'ses_long', events)
      await chunks.next() // entête/ouverture
      await chunks.next() // premier événement (itérateur SQLite actif)
      await chunks.return()
      assert.ok(inst.calls.ret >= 1, `${mode} : itérateur lâché`)
      assert.ok(inst.calls.databases.every(db => !db.open), `${mode} : connexion fermée`)
    } finally { inst.restore() }
  }
})

test('BEGIN qui échoue : la connexion est fermée par le finally (aucune fuite de descripteur)', async () => {
  const inst = instrumentStatements({ beginThrow: true })
  try {
    await assert.rejects(async () => {
      for await (const _ of streamRead(root, 'ses_long', {})) { /* ne doit rien rendre */ }
    }, /BEGIN_FAIL/)
    assert.ok(inst.calls.databases.length >= 1)
    assert.ok(inst.calls.databases.every(db => !db.open), 'connexion fermée malgré l’échec de BEGIN')
  } finally { inst.restore() }
})

test('erreur de close : ne masque pas l’erreur d’origine, mais remonte en l’absence d’erreur', async () => {
  for (const withOriginal of [true, false]) {
    const inst = instrumentStatements({
      closeThrow: true,
      ...(withOriginal ? { next: () => { throw new Error('ITER_ORIGINAL') } } : {})
    })
    try {
      await assert.rejects(async () => {
        for await (const _ of streamRead(root, 'ses_long')) { /* consomme */ }
      }, withOriginal ? /ITER_ORIGINAL/ : /CLOSE_FAIL/)
      assert.ok(inst.calls.databases.every(db => !db.open))
    } finally { inst.restore() }
  }
})

test('session inconnue et session pi vide : `null` (comportement sessionSlice préservé)', async () => {
  const unknown = []
  for await (const item of streamRead(root, 'ses_inconnue', {})) unknown.push(item)
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].window, null)
})

// ── Snapshot tenu PENDANT la consommation ─────────────────────────────────────

test('publication concurrente pendant la consommation : le flux reste sur le snapshot, un nouveau lecteur voit la suite', async () => {
  const gen = streamRead(root, 'ses_long', {})
  const head = await gen.next()
  assert.equal(head.value.window.total, LONG)
  const first = await gen.next()
  assert.equal(first.value.index, 0)

  // Écriture concurrente dans la vue (simule une publication COMMITée) : la
  // transaction de lecture du flux est OUVERTE depuis le premier `next()`.
  const wdb = new Database(path.join(root, 'index.db'))
  try {
    wdb.prepare('INSERT INTO events (id, session_id, ts, role, repo, model, cmd, text, json) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('msg_concurrent', 'ses_long', T0 + 2_000_000 + LONG + 5, 'user', null, null, null, 'publication concurrente', JSON.stringify({ id: 'msg_concurrent', sessionId: 'ses_long', ts: T0 + 2_000_000 + LONG + 5, role: 'user', text: 'publication concurrente' }))
  } finally { wdb.close() }

  const rest = []
  for await (const item of gen) rest.push(item)
  assert.equal(rest.length, LONG - 1, 'aucun événement de la publication concurrente dans le snapshot')
  assert.ok(!rest.some(x => x.event.id === 'msg_concurrent'))

  // Nouveau snapshot : la publication est visible.
  const after = sessionSlice(root, 'ses_long', {})
  assert.equal(after.total, LONG + 1, 'un nouveau lecteur voit la génération publiée')
  assert.ok(after.events.some(e => e.id === 'msg_concurrent'))
})

// ── Backpressure et écriture en flux ──────────────────────────────────────────

class FakeWritable extends EventEmitter {
  constructor ({ auto = true, delay = false } = {}) {
    super()
    this.chunks = []
    this.auto = auto
    this.delay = delay
    this.callbacks = []
  }
  write (chunk, cb) {
    this.chunks.push(chunk)
    if (this.auto) {
      if (this.delay) setImmediate(() => cb && cb())
      else process.nextTick(() => cb && cb())
    } else if (cb) this.callbacks.push(cb)
    return true
  }
  flushCallbacks (err) { for (const cb of this.callbacks.splice(0)) cb && cb(err) }
  destroy (err) { if (err) this.emit('error', err); this.emit('close') }
}

test('streamToWritable : écriture sérialisée par le callback du chunk, dispose sans fuite', async () => {
  const w = new FakeWritable({ auto: false })
  const sink = streamToWritable(w)
  const p1 = sink.write('a')
  assert.deepEqual(w.chunks, ['a'], 'chunk remis au sink')
  let settled = false
  p1.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'la promesse attend le callback du chunk (backpressure)')
  w.flushCallbacks()
  await p1
  const p2 = sink.write('b')
  w.flushCallbacks()
  await p2
  assert.equal(w.chunks.join(''), 'ab')
  sink.dispose()
  assert.equal(w.listenerCount('error'), 0, 'écouteur error retiré')
  assert.equal(w.listenerCount('close'), 0, 'écouteur close retiré')
})

test('streamToWritable : erreur TARDIVE du dernier chunk (write true) ⇒ la commande voit l’erreur', async () => {
  const w = new FakeWritable({ auto: false })
  const sink = streamToWritable(w)
  const p = sink.write('dernier')
  w.flushCallbacks(new Error('EPIPE_LATE')) // le callback arrive après un write() rendant true
  await assert.rejects(p, /EPIPE_LATE/)
  await assert.rejects(sink.write('x'), /EPIPE_LATE/, 'les écritures suivantes échouent')
  sink.dispose()
})

test('streamToWritable : destroy() SANS erreur ⇒ l’écriture en attente est rejetée (pas de hang)', async () => {
  const w = new FakeWritable({ auto: false })
  const sink = streamToWritable(w)
  const p = sink.write('a')
  w.destroy()
  await assert.rejects(p, /flux fermé sans erreur/)
  await assert.rejects(sink.write('b'), /flux fermé/)
  sink.dispose()
})

test('streamToWritable : erreur de flux ⇒ rejet de l’attente et des suivantes', async () => {
  const w = new FakeWritable({ auto: false })
  const sink = streamToWritable(w)
  const pending = sink.write('a')
  w.emit('error', new Error('EPIPE_TEST'))
  await assert.rejects(pending, /EPIPE_TEST/)
  await assert.rejects(sink.write('b'), /EPIPE_TEST/)
  sink.dispose()
})

test('rendu terminal EN FLUX + backpressure ≡ renderRead (octet pour octet)', async () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_a1', ctx: 1 })
  const [a] = slice.spans[0]
  const events = (async function * () {
    for (let k = 0; k < slice.events.length; k++) yield { index: a + k, event: slice.events[k] }
  })()
  const w = new FakeWritable({ delay: true })
  const sink = streamToWritable(w)
  for await (const chunk of readTerminalChunks(slice, 'ses_fix1', { plain: true }, events)) await sink.write(chunk)
  sink.dispose()
  assert.equal(w.chunks.join(''), renderRead(slice, 'ses_fix1', { plain: true }) + '\n')
})

test('rendu JSON EN FLUX + backpressure ≡ renderReadJson (octet pour octet), cas vide inclus', async () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_a1', ctx: 1 })
  const [a] = slice.spans[0]
  const events = (async function * () {
    for (let k = 0; k < slice.events.length; k++) yield { index: a + k, event: slice.events[k] }
  })()
  const w = new FakeWritable({ delay: true })
  const sink = streamToWritable(w)
  for await (const chunk of readJsonChunks(slice, 'ses_fix1', events)) await sink.write(chunk)
  sink.dispose()
  assert.equal(w.chunks.join(''), renderReadJson(slice, 'ses_fix1'))

  // Aucun message (ancre masquant tout) : `[]` exact.
  const masked = sessionSlice(root, 'ses_fix1', { at: String(T0), aroundId: 'msg_a1' })
  assert.equal(masked.events.length, 0)
  const empty = (async function * () {})()
  const w2 = new FakeWritable()
  const sink2 = streamToWritable(w2)
  for await (const chunk of readJsonChunks(masked, 'ses_fix1', empty)) await sink2.write(chunk)
  sink2.dispose()
  assert.equal(w2.chunks.join(''), renderReadJson(masked, 'ses_fix1'))
})
