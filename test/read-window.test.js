// M3b1 : primitives PARTAGÉES de fenêtre/pagination (`resolveReadWindowDb`,
// `pageKeys`) — métadonnées + clés (ts, id), jamais de json/text d'événement.
// Fixtures 100 % synthétiques ; source pi sous le tmp du test.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import { openView } from '../src/view.js'
import { sessionSliceDb, resolveReadWindowDb, pageKeys, resolveAnchor } from '../src/read.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-read-window-'))
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi-un')
const A0 = T0 + 1_000_000
const LONG_COUNT = 320
const LONG_BIG_IDX = 100
const LONG_TEXT = 'longstart ' + 'é'.repeat(60000)
let piEmptyId = null

function addMessage (db, { sesId, msgId, text, ts, role = 'user' }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run(sesId, 'p', `/root/${sesId}`, sesId, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(msgId, sesId, ts, ts, JSON.stringify({ role, agent: 'build' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
}

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    for (let i = 0; i < 5; i++) {
      addMessage(db, { sesId: 'ses_anchor', msgId: `msg_anc${i}`, text: `ancre message ${i}`, ts: A0 + i * 60000 })
    }
    for (let i = 0; i < LONG_COUNT; i++) {
      const id = `msg_long_${String(i).padStart(3, '0')}`
      addMessage(db, { sesId: 'ses_long', msgId: id, text: i === LONG_BIG_IDX ? LONG_TEXT : `message long ${i}`, ts: T0 + i })
    }
  } finally { db.close() }
  // Session pi SANS message (titre seul) : total 0 mais session connue.
  piEmptyId = fakeUuid()
  writePiSession(piDir, 'proj-empty', 'ses_empty.jsonl', [
    sessionLine(piEmptyId, T0, '/root/pi-empty'),
    infoLine(T0 + 10, 'Titre pi vide', 'infe')
  ])
  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Wrapper qui enregistre chaque SQL préparé (pour prouver l'absence de json/text). */
function tracked (db) {
  const sqls = []
  const wrapped = { prepare (sql) { sqls.push(sql); return db.prepare(sql) } }
  return { wrapped, sqls }
}

const keyOf = (k) => `${k.ts}|${k.id}`

// ── Parité CLI ↔ primitive ──────────────────────────────────────────────────

function parity (db, sessionId, opts) {
  const w = resolveReadWindowDb(db, sessionId, opts)
  const s = sessionSliceDb(db, sessionId, opts)
  if (w === null) { assert.equal(s, null); return { w, s } }
  if (w.total === 0) { assert.equal(s, null, 'CLI : total 0 → null (comportement préservé)'); return { w, s } }
  assert.equal(s.total, w.total)
  assert.equal(s.maxIdx, w.maxIdx)
  assert.equal(s.maskedCount, w.maskedCount)
  assert.deepEqual(s.anchor, w.anchor)
  assert.deepEqual(s.spans, w.spans)
  assert.equal(s.aroundIdx ?? null, w.aroundIdx)
  if (w.fatal) {
    assert.equal(s.fatal, true)
    assert.equal(s.error, w.error)
  } else {
    assert.equal(s.error ?? null, w.warning ?? null)
  }
  if (w.mode === 'around' || w.mode === 'tail') {
    assert.deepEqual(s.events.map((e) => keyOf({ ts: e.ts, id: e.id })), w.keys.map(keyOf))
  } else if (w.mode === 'all') {
    assert.equal(s.events.length, w.visible)
  } else {
    assert.equal(s.events.length, 0)
  }
  return { w, s }
}

test('parité CLI : around / tail / at / ctx0 / around inconnu / masqué', () => {
  const db = openView(root)
  try {
    parity(db, 'ses_anchor', {})
    parity(db, 'ses_anchor', { tail: 2 })
    parity(db, 'ses_anchor', { tail: 99 }) // > visible → tout
    parity(db, 'ses_anchor', { aroundId: 'msg_anc2', ctx: 1 })
    parity(db, 'ses_anchor', { aroundId: 'msg_anc2', ctx: 0 }) // ctx 0 = le message seul
    parity(db, 'ses_anchor', { aroundId: 'msg_inconnu' }) // repli vue lisible + avertissement
    parity(db, 'ses_anchor', { at: 'msg_anc2' })
    parity(db, 'ses_anchor', { at: 'msg_anc2', tail: 1 })
    parity(db, 'ses_anchor', { at: 'msg_anc2', aroundId: 'msg_anc4' }) // masqué → vide explicite
    parity(db, 'ses_anchor', { at: String(A0 + 120000) })
    assert.equal(resolveReadWindowDb(db, 'ses_inconnue', {}), null)
  } finally { db.close() }
})

test('parité CLI : ctx0 et masque avant fenêtre (bornes ancre inclusives)', () => {
  const db = openView(root)
  try {
    const ctx0 = resolveReadWindowDb(db, 'ses_anchor', { aroundId: 'msg_anc2', ctx: 0 })
    assert.equal(ctx0.mode, 'around')
    assert.deepEqual(ctx0.keys, [{ ts: A0 + 120000, id: 'msg_anc2' }])
    assert.deepEqual(ctx0.spans, [[2, 2]])

    const masked = resolveReadWindowDb(db, 'ses_anchor', { at: 'msg_anc2', aroundId: 'msg_anc4' })
    assert.equal(masked.mode, 'around-masked')
    assert.equal(masked.keys.length, 0)
    assert.equal(masked.aroundIdx, 4)
    assert.equal(masked.visible, 3)
    assert.equal(masked.maskedCount, 2)

    const tail = resolveReadWindowDb(db, 'ses_anchor', { at: 'msg_anc2', tail: 2 })
    assert.equal(tail.mode, 'tail')
    assert.deepEqual(tail.spans, [[1, 2]])
    assert.ok(tail.keys.every((k) => k.ts <= A0 + 120000), 'fenêtre bornée par l’ancre (inclusif)')
    assert.deepEqual(tail.keys.map(keyOf), [keyOf({ ts: A0 + 60000, id: 'msg_anc1' }), keyOf({ ts: A0 + 120000, id: 'msg_anc2' })])
  } finally { db.close() }
})

test('parité CLI : dates invalides → fatal (UTC strict, resolveAnchor partagé)', () => {
  const db = openView(root)
  try {
    const bad = parity(db, 'ses_anchor', { at: '2026-02-29' })
    assert.equal(bad.w.fatal, true)
    assert.match(bad.w.error, /jour hors bornes/)
    const ok = parity(db, 'ses_anchor', { at: '2028-02-29' })
    assert.equal(ok.w.fatal, false)
    const empty = resolveReadWindowDb(db, 'ses_anchor', { at: '' })
    assert.equal(empty.fatal, true)
    assert.match(empty.error, /ancre vide/)
  } finally { db.close() }
})

// ── Aucune lecture d'événements complets dans resolveReadWindowDb ───────────

test('resolveReadWindowDb ne lit NI json NI text d’événement (clés seules)', () => {
  const db = openView(root)
  try {
    for (const opts of [{}, { tail: 2 }, { aroundId: 'msg_anc2', ctx: 2 }, { at: 'msg_anc2' }, { aroundId: 'msg_inconnu' }]) {
      const { wrapped, sqls } = tracked(db)
      resolveReadWindowDb(wrapped, 'ses_anchor', opts)
      for (const sql of sqls) {
        if (!sql.includes('FROM events')) continue
        assert.ok(!/\bjson\b/i.test(sql), `aucun json d’événement chargé : ${sql}`)
        assert.ok(!/\btext\b/i.test(sql), `aucun text d’événement chargé : ${sql}`)
      }
    }
  } finally { db.close() }
})

// ── Session longue : clés bornées, pas de matérialisation ───────────────────

test('session > 300 messages (dont 60k chars) : around/tail bornés, all sans clés', () => {
  const db = openView(root)
  try {
    const around = resolveReadWindowDb(db, 'ses_long', { aroundId: `msg_long_${LONG_BIG_IDX}`, ctx: 2 })
    assert.equal(around.mode, 'around')
    assert.equal(around.total, LONG_COUNT)
    assert.equal(around.keys.length, 5, '2*ctx+1 clés au plus')
    assert.ok(around.keys.some((k) => k.id === `msg_long_${String(LONG_BIG_IDX).padStart(3, '0')}`))

    const tail = resolveReadWindowDb(db, 'ses_long', { tail: 10 })
    assert.equal(tail.keys.length, 10)
    assert.deepEqual(tail.spans, [[LONG_COUNT - 10, LONG_COUNT - 1]])

    const all = resolveReadWindowDb(db, 'ses_long', {})
    assert.equal(all.mode, 'all')
    assert.equal(all.keys.length, 0, 'mode all : AUCUNE clé matérialisée')
    assert.equal(all.visible, LONG_COUNT)

    // Instrumentation : aucune requête json/text même sur la session longue.
    const { wrapped, sqls } = tracked(db)
    resolveReadWindowDb(wrapped, 'ses_long', { aroundId: `msg_long_${LONG_BIG_IDX}`, ctx: 2 })
    for (const sql of sqls) if (sql.includes('FROM events')) assert.ok(!/json|text/i.test(sql), sql)
  } finally { db.close() }
})

// ── pageKeys : keyset, ≤200 + lookahead, aucun OFFSET ───────────────────────

test('pageKeys : pagination KEYSET complète, ≤200 + lookahead, sans OFFSET', () => {
  const db = openView(root)
  try {
    const { wrapped, sqls } = tracked(db)
    const p1 = pageKeys(wrapped, 'ses_long', { limit: 200 })
    assert.equal(p1.keys.length, 200)
    assert.equal(p1.hasMore, true)
    const p2 = pageKeys(wrapped, 'ses_long', { limit: 200, after: p1.keys[p1.keys.length - 1] })
    assert.equal(p2.keys.length, LONG_COUNT - 200)
    assert.equal(p2.hasMore, false)
    // Recollement sans trou ni doublon, ordre exact.
    const all = [...p1.keys, ...p2.keys].map(keyOf)
    const expected = db.prepare("SELECT ts, id FROM events WHERE session_id = 'ses_long' AND role != 'title' ORDER BY ts, id").all().map(keyOf)
    assert.equal(new Set(all).size, LONG_COUNT)
    assert.deepEqual(all, expected)
    for (const sql of sqls) {
      if (!sql.includes('FROM events')) continue
      assert.ok(!/OFFSET/i.test(sql), 'aucun OFFSET (keyset)')
      assert.ok(!/json|text/i.test(sql))
    }
    // Borne ancre inclusive.
    const bounded = pageKeys(db, 'ses_anchor', { anchorTs: A0 + 120000, limit: 200 })
    assert.equal(bounded.keys.length, 3)
    assert.ok(bounded.keys.every((k) => k.ts <= A0 + 120000))
  } finally { db.close() }
})

// ── Session connue sans message : reconnue, CLI null ────────────────────────

test('session pi sans message : resolveReadWindowDb la RECONNAÎT, sessionSliceDb rend null', () => {
  const db = openView(root)
  try {
    assert.ok(piEmptyId, 'uuid de la session pi vide')
    const sid = `pi:${piEmptyId}`
    const w = resolveReadWindowDb(db, sid, {})
    assert.notEqual(w, null, 'session reconnue malgré total 0')
    assert.equal(w.total, 0)
    assert.equal(w.mode, 'empty')
    assert.ok(w.ses)
    assert.equal(sessionSliceDb(db, sid, {}), null, 'CLI : comportement null préservé')
  } finally { db.close() }
})

test('session pi vide : `at` TOUJOURS validé (horodatage → ancre/maskedCount 0 ; invalide → fatal)', () => {
  const db = openView(root)
  try {
    const sid = `pi:${piEmptyId}`
    const valid = resolveReadWindowDb(db, sid, { at: String(T0) })
    assert.equal(valid.total, 0)
    assert.equal(valid.mode, 'empty')
    assert.equal(valid.fatal, false)
    assert.equal(valid.visible, 0)
    assert.equal(valid.maskedCount, 0)
    assert.equal(valid.anchor.ts, T0)
    assert.equal(valid.anchor.source, 'horodatage')
    assert.equal(valid.ses.source, 'pi', 'session pi reconnue pour la future fidélité read vide')

    const validDate = resolveReadWindowDb(db, sid, { at: '2028-02-29' })
    assert.equal(validDate.fatal, false)
    assert.equal(validDate.anchor.source, 'horodatage')
    assert.equal(validDate.maskedCount, 0)

    const badDate = resolveReadWindowDb(db, sid, { at: '2026-02-29' })
    assert.equal(badDate.fatal, true)
    assert.match(badDate.error, /jour hors bornes/)

    const unknown = resolveReadWindowDb(db, sid, { at: 'msg_nope' })
    assert.equal(unknown.fatal, true)
    assert.match(unknown.error, /introuvable/)

    const other = resolveReadWindowDb(db, sid, { at: 'msg_anc1' })
    assert.equal(other.fatal, true)
    assert.match(other.error, /appartient à la session/)

    // Wrapper CLI : `total 0 ⇒ null` préservé, y compris ancre invalide.
    for (const at of [String(T0), '2026-02-29', 'msg_nope', 'msg_anc1']) {
      assert.equal(sessionSliceDb(db, sid, { at }), null)
    }
  } finally { db.close() }
})

test('ligne de TITRE jamais un message : `at` titre → fatal, `around` titre → repli introuvable', () => {
  const db = openView(root)
  try {
    // id de la ligne de titre = id de session.
    const atTitle = resolveReadWindowDb(db, 'ses_anchor', { at: 'ses_anchor' })
    assert.equal(atTitle.fatal, true)
    assert.match(atTitle.error, /introuvable/)
    assert.equal(sessionSliceDb(db, 'ses_anchor', { at: 'ses_anchor' }).fatal, true)

    const aroundTitle = resolveReadWindowDb(db, 'ses_anchor', { aroundId: 'ses_anchor' })
    assert.equal(aroundTitle.mode, 'all')
    assert.match(aroundTitle.warning, /introuvable/)
    const s = sessionSliceDb(db, 'ses_anchor', { aroundId: 'ses_anchor' })
    assert.equal(s.events.length, 5)
    assert.match(s.error, /introuvable/)

    assert.match(resolveAnchor(db, 'ses_anchor', null, 'ses_anchor').error, /introuvable/)
    assert.deepEqual(resolveAnchor(db, 'msg_anc1', null, 'ses_anchor'), { ts: A0 + 60000, id: 'msg_anc1' })
  } finally { db.close() }
})
