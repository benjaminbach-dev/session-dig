// Handler `sdig_read` (sous-lot M3b2) : pagination keyset, fragments SQL bornés,
// curseurs opaques, budget, NUL. Fixtures 100 % synthétiques ; source pi sous tmp.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import { sessionSlice } from '../src/read.js'
import {
  createReadHandler,
  validateReadInput,
  readOutputSchema,
  appErrorPayload,
  measureSerialized,
  RESPONSE_BUDGET_BYTES,
  createMcpTestServer,
  CursorStore,
  CURSOR_TTL_MS,
  MAX_CURSOR_CHARS
} from '../src/mcp/index.js'
import { PI_FIDELITY_LIMITS, PI_FIDELITY_NOTE } from '../src/format.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-read-'))
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi-un')
const piAbsent = process.env.SESSION_DIG_PI_DIR
const A0 = T0 + 1_000_000
const LONG_COUNT = 320
const LONG_BIG_IDX = 100
const LONG_TEXT = 'L' + 'é'.repeat(60000)
const NUL_TEXT = 'avant\u0000après😀fin'
const GIANT_TITLE = 'G' + 'x'.repeat(600000)

function addMessage (db, { sesId, msgId, text, ts, title = null, role = 'user' }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run(sesId, 'p', `/root/${sesId}`, title ?? sesId, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(msgId, sesId, ts, ts, JSON.stringify({ role, agent: 'build' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
}

let piId = null
let piEmptyId = null

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    for (let i = 0; i < 5; i++) addMessage(db, { sesId: 'ses_anchor', msgId: `msg_anc${i}`, text: `ancre ${i}`, ts: A0 + i * 60000 })
    for (let i = 0; i < LONG_COUNT; i++) {
      addMessage(db, { sesId: 'ses_long', msgId: `msg_long_${String(i).padStart(3, '0')}`, text: i === LONG_BIG_IDX ? LONG_TEXT : `court ${i}`, ts: T0 + i })
    }
    addMessage(db, { sesId: 'ses_nul', msgId: 'msg_nul', text: NUL_TEXT, ts: T0 + 500000 })
    addMessage(db, { sesId: 'ses_giant', msgId: 'msg_giant', text: 'normal', ts: T0 + 600000, title: GIANT_TITLE })
    for (let i = 0; i < 250; i++) addMessage(db, { sesId: 'ses_many', msgId: `msg_many_${String(i).padStart(3, '0')}`, text: `petit ${i}`, ts: T0 + 700000 + i })
    // Budget arrêté AVANT un message (offset 0) : 30 messages de 20 000 chars.
    for (let i = 0; i < 30; i++) addMessage(db, { sesId: 'ses_offset0', msgId: `msg_off_${String(i).padStart(2, '0')}`, text: 'o'.repeat(20000), ts: T0 + 800000 + i })
    // Métadonnée énorme + message à fragment RÉDUIT par budget.
    addMessage(db, { sesId: 'ses_meta', msgId: 'msg_meta', text: 'm'.repeat(80000), ts: T0 + 900000, title: 'M' + 'y'.repeat(510000) })
    // NUL > 4 Mio : chunks BLOB bornés, aucun cap qui refuserait le texte.
    addMessage(db, { sesId: 'ses_nulbig', msgId: 'msg_nulbig', text: '\u0000' + 'a'.repeat(4 * 1024 * 1024 + 100000) + '😀é', ts: T0 + 950000 })
    // Message pour la frontière budget « seul 1 point tient » (titre calibré au test).
    addMessage(db, { sesId: 'ses_tight', msgId: 'msg_tight', text: 'x'.repeat(2000), ts: T0 + 960000, title: 'T'.repeat(523414) })
  } finally { db.close() }

  piId = fakeUuid()
  writePiSession(piDir, 'proj-pi', 'ses_pi.jsonl', [
    sessionLine(piId, T0, '/root/pi-un'),
    infoLine(T0 + 10, 'Titre pi', 'inf'),
    messageLine(T0 + 1000, { role: 'user', content: [{ type: 'text', text: 'message pi un' }], timestamp: T0 + 1000 }),
    messageLine(T0 + 2000, { role: 'assistant', content: [{ type: 'text', text: 'message pi deux' }], timestamp: T0 + 2000 })
  ])
  piEmptyId = fakeUuid()
  writePiSession(piDir, 'proj-empty', 'ses_empty.jsonl', [
    sessionLine(piEmptyId, T0, '/root/pi-empty'),
    infoLine(T0 + 10, 'Titre pi vide', 'infe')
  ])

  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const cfg = { root, sources: { opencode: { path: dbPath }, pi: { path: piDir } } }
const piSid = () => `pi:${piId}`
const piEmptySid = () => `pi:${piEmptyId}`

function call (handler, raw) {
  const v = validateReadInput(raw)
  return handler(v.value, v.adaptations)
}

function expectAppError (fn, code, reason = null) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    const p = appErrorPayload(e)
    assert.equal(p.code, code)
    if (reason != null) assert.equal(p.reason, reason)
    assert.ok(!JSON.stringify(p).includes(tmp), 'aucun chemin local')
    return p
  }
}

const newHandler = (opts) => createReadHandler(cfg, opts)

// ── Nominal + parité temporelle CLI ─────────────────────────────────────────

test('read nominal : messages complets, références read, unités explicites, schéma', () => {
  const out = call(newHandler(), { session: 'ses_fix1' })
  assert.ok(readOutputSchema.safeParse(out).success)
  assert.equal(out.sessionId, 'ses_fix1')
  assert.equal(out.offsetUnit, 'unicode-code-point')
  assert.equal(out.encoding, 'utf-8')
  assert.ok(out.messages.length >= 1)
  for (const m of out.messages) {
    assert.equal(typeof m.text, 'string')
    assert.ok(Number.isInteger(m.offset) && Number.isInteger(m.end))
    assert.equal(m.complete, true)
  }
  assert.equal(out.truncated, undefined)
})

test('parité temporelle CLI : anchor/maskedCount/visible/total identiques à sessionSlice', () => {
  const slice = sessionSlice(root, 'ses_anchor', { at: 'msg_anc2' })
  const out = call(newHandler(), { session: 'ses_anchor', at: 'msg_anc2' })
  assert.equal(out.anchor.ts, slice.anchor.ts)
  assert.equal(out.anchor.source, slice.anchor.source)
  assert.equal(out.maskedCount, slice.maskedCount)
  assert.equal(out.visible, slice.maxIdx + 1)
  assert.equal(out.total, slice.total)
  assert.deepEqual(out.messages.map((m) => m.id), slice.events.map((e) => e.id))
})

test('around prioritaire sur tail ; futur jamais réinclus sous ancre', () => {
  const out = call(newHandler(), { session: 'ses_anchor', at: 'msg_anc2', around: 'msg_anc1', ctx: 1, tail: 1 })
  assert.deepEqual(out.messages.map((m) => m.id), ['msg_anc0', 'msg_anc1', 'msg_anc2'])
  const tail = call(newHandler(), { session: 'ses_anchor', at: 'msg_anc2', tail: 2 })
  assert.ok(tail.messages.every((m) => m.ts <= A0 + 120000), 'aucun message postérieur à l’ancre')
})

test('around introuvable : repli vue lisible + texte FIXE (aucun écho de l’entrée)', () => {
  const out = call(newHandler(), { session: 'ses_anchor', around: 'msg_secret_inconnu' })
  assert.ok(out.messages.length >= 1)
  assert.ok(!out.error.includes('msg_secret_inconnu'), 'pas d’écho de l’identifiant demandé')
  assert.ok(!out.error.includes('ses_anchor'))
})

test('masked / vide : non-erreur applicative, ancre et comptes exposés', () => {
  const masked = call(newHandler(), { session: 'ses_anchor', at: 'msg_anc2', around: 'msg_anc4' })
  assert.equal(masked.messages.length, 0)
  assert.equal(masked.anchor.ts, A0 + 120000)
  assert.equal(masked.maskedCount, 2)
  assert.ok(masked.error)
  const empty = call(newHandler(), { session: piEmptySid() })
  assert.equal(empty.messages.length, 0)
  assert.equal(empty.total, 0)
  assert.ok(empty.error)
})

// ── Fragments bornés, Unicode, NUL ──────────────────────────────────────────

test('message de 60 000 chars : pages de ≤20 000, recollement EXACT, curseur final absent', () => {
  const handler = newHandler()
  let cursor = null
  let text = ''
  let pages = 0
  for (;;) {
    const out = cursor ? call(handler, { cursor }) : call(handler, { session: 'ses_long', around: `msg_long_${String(LONG_BIG_IDX).padStart(3, '0')}`, ctx: 0, full: true })
    assert.ok(readOutputSchema.safeParse(out).success)
    for (const m of out.messages) {
      assert.ok([...m.text].length <= 20000, 'fragment ≤ 20 000 points de code')
      assert.equal(m.offset, [...text].length, 'offset contigu (aucun trou)')
      text += m.text
    }
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    assert.ok(cursor.length <= MAX_CURSOR_CHARS)
    if (pages > 10) assert.fail('trop de pages')
  }
  assert.equal(text, LONG_TEXT, 'recollement exact (accents compris)')
  assert.equal(pages, 4, '60001 points de code / 20 000 ⇒ 4 pages')
})

test('Unicode + U+0000 : texte exact (accents, emoji, NUL), pas de troncature au NUL', () => {
  const out = call(newHandler(), { session: 'ses_nul' })
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].text, NUL_TEXT)
  assert.equal(out.messages[0].complete, true)
  assert.equal(out.messages[0].end, [...NUL_TEXT].length)
  assert.ok(out.messages[0].text.includes('\u0000'))
  assert.ok(out.messages[0].text.includes('😀'))
})

test('page ≤200 messages distincts, dernière page sans curseur', () => {
  const handler = newHandler()
  const p1 = call(handler, { session: 'ses_many' })
  assert.equal(p1.messages.length, 200)
  assert.ok(p1.truncated.nextCursor)
  const p2 = call(handler, { cursor: p1.truncated.nextCursor })
  assert.equal(p2.messages.length, 50)
  assert.equal(p2.truncated, undefined, 'dernière page sans curseur')
  const ids = [...p1.messages, ...p2.messages].map((m) => m.id)
  assert.equal(new Set(ids).size, 250, 'aucun doublon')
})

test('métadonnée (titre) hors budget ⇒ erreur bornée budget_exhausted', () => {
  expectAppError(() => call(newHandler(), { session: 'ses_giant' }), 'internal', 'budget_exhausted')
})

test('around sans ctx : défaut CLI 10 (parité partagée)', () => {
  const cli = sessionSlice(root, 'ses_long', { aroundId: 'msg_long_150' })
  const out = call(newHandler(), { session: 'ses_long', around: 'msg_long_150' })
  assert.equal(cli.events.length, 21)
  assert.deepEqual(out.messages.map((m) => m.id), cli.events.map((e) => e.id))
})

test('budget arrêté AVANT un message (offset 0) : la continuation NE SAUTE PAS ce message', () => {
  const handler = newHandler()
  const seen = []
  let text = ''
  let cursor = null
  let pages = 0
  for (;;) {
    const out = cursor ? call(handler, { cursor }) : call(handler, { session: 'ses_offset0', full: true })
    assert.ok(readOutputSchema.safeParse(out).success)
    for (const m of out.messages) {
      seen.push(m.id)
      text += m.text
    }
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (pages > 40) assert.fail('trop de pages')
  }
  assert.equal(new Set(seen).size, 30, 'aucun message sauté ni dupliqué')
  assert.deepEqual(seen, [...seen].sort(), 'ordre (ts,id) conservé')
  assert.equal(text.length, 30 * 20000, 'recollement exact')
  assert.equal(pages, 2, '30 messages de 20 000 / budget ⇒ 2 pages')
  // Total EXACT connu pour la fenêtre `all` : w.visible.
  const first = call(newHandler(), { session: 'ses_offset0', full: true })
  assert.equal(first.truncated.dimensions.find((d) => d.dimension === 'messages').total, 30)
})

test('frontière 1 point : fragment réduit à 1 point émis (pas budget_exhausted)', () => {
  const handler = newHandler()
  const vp = path.join(root, 'index.db')
  const setTitle = (n) => {
    const db = new Database(vp)
    try { db.prepare("UPDATE sessions SET title = ?, json = json_set(json, '$.title', ?) WHERE id = ?").run('T'.repeat(n), 'T'.repeat(n), 'ses_tight') } finally { db.close() }
  }
  const probe = (n) => {
    setTitle(n)
    try { const out = call(handler, { session: 'ses_tight', full: true }); return { len: out.messages[0] ? [...out.messages[0].text].length : 0 } } catch (e) { return { err: appErrorPayload(e).reason } }
  }
  // Recherche de la frontière : plus grand titre où un fragment >= 1 point tient.
  let lo = 500000
  let hi = 530000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const r = probe(mid)
    if (!r.err && r.len >= 1) lo = mid + 1
    else hi = mid
  }
  const T = lo - 1
  // Métadonnée + 1 point + curseur/dims tiennent EXACTEMENT ; 1 octet de plus échoue.
  assert.equal(probe(T).len, 1, `frontière 1 point (titre ${T})`)
  assert.equal(probe(T + 1).err, 'budget_exhausted', 'un octet de plus ⇒ représentation minimale hors budget')
})

test('around : position de fenêtre introuvable ⇒ invalid_cursor (jamais de reprise silencieuse à 0)', () => {
  const handler = newHandler()
  const out = call(handler, { session: 'ses_anchor', around: 'msg_anc2', ctx: 1, chars: 1 })
  assert.ok(out.truncated && out.truncated.nextCursor)
  // La clé de POSITION du curseur est le premier message de la fenêtre (around ctx=1).
  const posId = out.messages[0].id
  // Suppression MANUELLE (hors protocole) de cette clé, sans toucher génération/watermark.
  const db = new Database(path.join(root, 'index.db'))
  try { db.prepare('DELETE FROM events WHERE id = ?').run(posId) } finally { db.close() }
  expectAppError(() => call(handler, { cursor: out.truncated.nextCursor }), 'invalid_cursor')
  index(root) // restaure la vue dérivée (et la génération)
})

test('métadonnée énorme + fragment RÉDUIT : pas d’erreur, recollement exact', () => {
  const handler = newHandler()
  let cursor = null
  let text = ''
  let firstLen = null
  let pages = 0
  for (;;) {
    const out = cursor ? call(handler, { cursor }) : call(handler, { session: 'ses_meta', full: true })
    assert.ok(readOutputSchema.safeParse(out).success)
    if (firstLen == null && out.messages.length) firstLen = [...out.messages[0].text].length
    for (const m of out.messages) text += m.text
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (pages > 20) assert.fail('trop de pages')
  }
  assert.ok(firstLen != null && firstLen < 20000, 'fragment réduit sous le plafond (métadonnée énorme)')
  assert.equal(text, 'm'.repeat(80000), 'recollement exact')
})

test('NUL > 4 Mio : chunks BLOB bornés, recollement exact, aucune requête de BLOB entier', () => {
  const sqls = []
  const realPrepare = Database.prototype.prepare
  Database.prototype.prepare = function (sql, ...rest) { sqls.push(sql); return realPrepare.call(this, sql, ...rest) }
  let text = ''
  let cursor = null
  let pages = 0
  try {
    const handler = newHandler()
    for (;;) {
      const out = cursor ? call(handler, { cursor }) : call(handler, { session: 'ses_nulbig', full: true })
      assert.ok(readOutputSchema.safeParse(out).success)
      for (const m of out.messages) text += m.text
      pages++
      if (!out.truncated || !out.truncated.nextCursor) break
      cursor = out.truncated.nextCursor
      if (pages > 400) assert.fail('trop de pages')
    }
  } finally { Database.prototype.prepare = realPrepare }
  assert.equal(text[0], '\u0000', 'NUL de tête conservé')
  assert.ok(text.endsWith('😀é'), 'Unicode final exact')
  assert.equal([...text].length, 1 + (4 * 1024 * 1024 + 100000) + 2, 'aucune perte de points de code')
  assert.ok(sqls.some((s) => s.includes('substr(CAST(') && s.includes('AS chunk')), 'chunk BLOB borné utilisé')
  assert.ok(!sqls.some((s) => /CAST\(e\.text AS BLOB\)\s+AS blob/i.test(s)), 'aucun BLOB entier transféré')
})

test('CursorStore : limites invalides refusées au constructeur', () => {
  assert.throws(() => new CursorStore({ max: -1 }), /max/)
  assert.throws(() => new CursorStore({ max: 0 }), /max/)
  assert.throws(() => new CursorStore({ max: Number.POSITIVE_INFINITY }), /max/)
  assert.throws(() => new CursorStore({ ttlMs: -5 }), /ttlMs/)
  assert.throws(() => new CursorStore({ ttlMs: 0 }), /ttlMs/)
  assert.ok(new CursorStore({ max: 1, ttlMs: 1 }))
})

// ── Fidélité pi (initiale, continuée, vide) ─────────────────────────────────

test('read pi : fidélité générale présente (initiale, continuée, vide), budget tenu', () => {
  const fidelity = { source: 'pi', general: true, limits: [...PI_FIDELITY_LIMITS], note: PI_FIDELITY_NOTE }
  const handler = newHandler()
  const init = call(handler, { session: piSid() })
  assert.deepEqual(init.fidelity, fidelity)
  assert.ok(init.messages.length >= 1)
  const cont = call(handler, { session: piSid(), tail: 1 })
  assert.deepEqual(cont.fidelity, fidelity)
  const empty = call(handler, { session: piEmptySid() })
  assert.deepEqual(empty.fidelity, fidelity)
  assert.equal(empty.messages.length, 0)
  // opencode : aucune fidélité
  const oc = call(handler, { session: 'ses_fix1' })
  assert.equal(oc.fidelity, undefined)
})

// ── Curseurs ────────────────────────────────────────────────────────────────

test('curseur : altéré / étranger ⇒ invalid_cursor', () => {
  const handler = newHandler()
  const p1 = call(handler, { session: 'ses_long' })
  const cursor = p1.truncated.nextCursor
  expectAppError(() => call(handler, { cursor: 'pas-un-jeton' }), 'invalid_cursor')
  expectAppError(() => call(handler, { cursor: 'f'.repeat(64) }), 'invalid_cursor')
  // Un jeton valide mais inconnu de CE handler (étranger) ⇒ invalid_cursor.
  expectAppError(() => call(newHandler(), { cursor }), 'invalid_cursor')
})

test('curseur : expiration et éviction ⇒ invalid_cursor', () => {
  let now = 1_000_000
  const store = new CursorStore({ now: () => now })
  const handler = createReadHandler(cfg, { cursors: store })
  const p1 = call(handler, { session: 'ses_long' })
  const cursor = p1.truncated.nextCursor
  now += CURSOR_TTL_MS + 1
  expectAppError(() => call(handler, { cursor }), 'invalid_cursor')

  const small = new CursorStore({ max: 2 })
  const h2 = createReadHandler(cfg, { cursors: small })
  const c1 = call(h2, { session: 'ses_many' }).truncated.nextCursor
  call(h2, { session: 'ses_many' })
  call(h2, { session: 'ses_many' })
  assert.equal(small.size, 2)
  expectAppError(() => call(h2, { cursor: c1 }), 'invalid_cursor', null)
})

test('curseur : changement de génération (rebuild) ⇒ stale_cursor', () => {
  const handler = newHandler()
  const p1 = call(handler, { session: 'ses_long' })
  const cursor = p1.truncated.nextCursor
  index(root) // rebuild : génération renouvelée, corpus/watermarks identiques
  expectAppError(() => call(handler, { cursor }), 'stale_cursor')
})

test('curseur : redémarrage (nouveau handler) ⇒ invalid_cursor ; dispose purge', () => {
  const h1 = newHandler()
  const cursor = call(h1, { session: 'ses_long' }).truncated.nextCursor
  h1.dispose()
  expectAppError(() => call(h1, { cursor }), 'invalid_cursor')
  assert.equal(h1.cursors.size, 0)
})

// ── Vue ancienne sans génération ────────────────────────────────────────────

test('vue ancienne sans génération : page unique sans curseur OK ; suite ⇒ view_unavailable', () => {
  const db = new Database(path.join(root, 'index.db'))
  try { db.prepare("DELETE FROM meta WHERE key = 'generation'").run() } finally { db.close() }
  const handler = newHandler()
  // Page unique : succès sans curseur.
  const single = call(handler, { session: 'ses_fix1' })
  assert.ok(single.messages.length >= 1)
  assert.equal(single.truncated, undefined)
  // Suite nécessaire : refus sans curseur faux.
  expectAppError(() => call(handler, { session: 'ses_long' }), 'view_unavailable', 'invalid_schema')
  index(root) // restaure une génération pour la suite
})

// ── Erreurs closes, sans fuite ──────────────────────────────────────────────

test('erreurs : unknown_session / invalid_anchor / date vide / TZ / ancre autre session', () => {
  const handler = newHandler()
  expectAppError(() => call(handler, { session: 'ses_inconnue' }), 'unknown_session')
  expectAppError(() => call(handler, { session: 'ses_fix1', at: 'pas-une-date' }), 'invalid_anchor')
  expectAppError(() => call(handler, { session: 'ses_fix1', at: '' }), 'invalid_anchor')
  expectAppError(() => call(handler, { session: 'ses_fix1', at: '2026-06-10T10:00+02:00' }), 'invalid_anchor')
  expectAppError(() => call(handler, { session: 'ses_anchor', at: 'msg_u1' }), 'invalid_anchor')
})

// ── Client MCP HTTP officiel (port OS éphémère) ─────────────────────────────

function rawToolCall (port, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sdig_read', arguments: args } })
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: { host: `127.0.0.1:${port}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25', 'content-length': Buffer.byteLength(body) },
      setHost: false
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

test('client MCP réel : read rendu, curseur enchaîné, enveloppe ≤ budget', async () => {
  const handlers = {
    sdig_search: async () => ({}),
    sdig_read: createReadHandler(cfg),
    sdig_status: async () => ({ counts: { sessions: 0, events: 0 }, rawFiles: null, rawReferences: 0, view: null, viewNote: null, sources: {}, freshness: { sources: {}, indexMtime: null, corpusVersion: null } })
  }
  const srv = createMcpTestServer({ handlers })
  await srv.start()
  try {
    assert.notEqual(srv.address().port, 18767)
    const client = new Client({ name: 'mcp-read-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`))
    await client.connect(transport)
    try {
      const res = await client.callTool({ name: 'sdig_read', arguments: { session: 'ses_fix1' } })
      assert.notEqual(res.isError, true)
      assert.ok(readOutputSchema.safeParse(res.structuredContent).success)
      const bad = await client.callTool({ name: 'sdig_read', arguments: { session: 'ses_fix1', cursor: 'x' } })
      assert.equal(bad.isError, true)
      assert.equal(JSON.parse(bad.content[0].text).code, 'invalid_params')
    } finally { await client.close() }
    // Enveloppe réelle sur le fil pour un read lourd.
    const heavy = await rawToolCall(srv.address().port, { session: 'ses_long' })
    assert.equal(heavy.status, 200)
    assert.ok(Buffer.byteLength(heavy.text) <= RESPONSE_BUDGET_BYTES, `enveloppe ${Buffer.byteLength(heavy.text)}`)
  } finally {
    await srv.close()
  }
})
