// Fragmentation SANS PERTE des commandes du handler `sdig_read` (correctif
// budget_exhausted sur `cmd` géante). Tests DURABLES exécutables SANS SDK ni zod :
// imports DIRECTS de `read.js`/`errors.js`/`constants.js`/`budget.js`/`cursor.js`
// (jamais `index.js` ni `schemas.js`), fixtures 100 % synthétiques sous tmp.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import { createReadHandler } from '../src/mcp/read.js'
import { appErrorPayload } from '../src/mcp/errors.js'
import { measureSerialized } from '../src/mcp/budget.js'
import { RESPONSE_BUDGET_BYTES, MAX_READ_CHARS, MAX_ID_STRING_CHARS } from '../src/mcp/constants.js'
import { CursorStore, CURSOR_TTL_MS } from '../src/mcp/cursor.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-read-frag-'))
const PREV_PI_DIR = process.env.SESSION_DIG_PI_DIR
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi')
const PI_SES = fakeUuid()
const PI_NEXT_SES = fakeUuid()

// Commande ASCII de 614 400 caractères (défaut PROUVÉ) — textes longs en +
// appels multiples, Unicode et U+0000, métadonnées volumineuses.
const BIG_CMD = 'A'.repeat(614400)
const BIG_UNI = 'é😀' + 'u'.repeat(300000) + '×'
const BIG_NUL = 'avant\u0000après😀' + 'z'.repeat(200000)
const TEXT_LONG = 'T' + 'é'.repeat(60000)

function addOcText (db, { sesId, msgId, text, ts, title = null, role = 'user' }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run(sesId, 'p', `/root/${sesId}`, title ?? sesId, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(msgId, sesId, ts, ts, JSON.stringify({ role, agent: 'build' }))
  if (text != null) db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
}

function addOcTool (db, { sesId, msgId, cmd, ts, tool = 'bash', text = null, exitCode = 0 }) {
  addOcText(db, { sesId, msgId, text, ts, role: 'assistant' })
  const state = { status: 'completed', input: cmd == null ? {} : { command: cmd } }
  if (exitCode !== undefined) state.metadata = { exitCode }
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_tool_${msgId}`, msgId, sesId, ts + 1, ts + 1, JSON.stringify({ type: 'tool', tool, state }))
}

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    // Pi : message à commande SEULE (texte vide) de 614 400 chars, puis message
    // ordinaire suivant (la suite doit y mener).
    writePiSession(piDir, 'proj', 'ses_pi.jsonl', [
      sessionLine(PI_SES, T0, '/root/pi'),
      infoLine(T0 + 10, 'Titre pi', 'inf'),
      messageLine(T0 + 1000, { role: 'assistant', timestamp: T0 + 1000, content: [{ type: 'toolCall', id: 'call_big', name: 'bash', arguments: { command: BIG_CMD } }] }),
      messageLine(T0 + 2000, { role: 'user', timestamp: T0 + 2000, content: [{ type: 'text', text: 'message pi suivant' }] })
    ])
    // Pi : commande Unicode + appel sans commande + appel vide.
    writePiSession(piDir, 'proj2', 'ses_pi_uni.jsonl', [
      sessionLine(PI_NEXT_SES, T0 + 5000, '/root/pi'),
      messageLine(T0 + 6000, { role: 'assistant', timestamp: T0 + 6000, content: [{ type: 'toolCall', id: 'call_u', name: 'bash', arguments: { command: BIG_UNI } }] })
    ])
  } finally { db.close() }

  {
    const db = new Database(dbPath)
    const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
    try {
      // OpenCode : commande géante ASCII seule.
      addOcTool(db, { sesId: 'ses_oc_big', msgId: 'msg_oc_big', cmd: BIG_CMD, ts: T0 + 1000 })
      addOcText(db, { sesId: 'ses_oc_big', msgId: 'msg_oc_next', text: 'message oc suivant', ts: T0 + 2000 })
      // OpenCode : texte long + commande géante.
      addOcText(db, { sesId: 'ses_mix', msgId: 'msg_mix_text', text: TEXT_LONG, ts: T0 + 3000 })
      addOcTool(db, { sesId: 'ses_mix', msgId: 'msg_mix_tool', cmd: BIG_CMD, ts: T0 + 4000 })
      // Plusieurs appels : un gros au milieu, des petits autour.
      addOcText(db, { sesId: 'ses_multi', msgId: 'msg_multi', text: 'intro', ts: T0 + 5000, role: 'assistant' })
      insPart.run('prt_m0', 'msg_multi', 'ses_multi', T0 + 5001, T0 + 5001, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'petit-a' }, metadata: { exitCode: 0 } } }))
      insPart.run('prt_m1', 'msg_multi', 'ses_multi', T0 + 5002, T0 + 5002, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: BIG_CMD }, metadata: { exitCode: 0 } } }))
      insPart.run('prt_m2', 'msg_multi', 'ses_multi', T0 + 5003, T0 + 5003, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', input: { file: 'x.txt' }, metadata: { exitCode: 0 } } }))
      // Grande quantité de petits appels sans commande (nominal).
      addOcText(db, { sesId: 'ses_manycalls', msgId: 'msg_manycalls', text: 'plusieurs', ts: T0 + 6000, role: 'assistant' })
      for (let i = 0; i < 40; i++) {
        insPart.run(`prt_mc_${i}`, 'msg_manycalls', 'ses_manycalls', T0 + 6001 + i, T0 + 6001 + i, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', input: { file: `f${i}.txt` }, metadata: { exitCode: 0 } } }))
      }
      // Unicode + NUL dans la commande.
      addOcTool(db, { sesId: 'ses_nulcmd', msgId: 'msg_nulcmd', cmd: BIG_NUL, ts: T0 + 7000 })
      // Texte Unicode + U+0000 (comportement texte préservé).
      addOcText(db, { sesId: 'ses_nultext', msgId: 'msg_nultext', text: BIG_NUL, ts: T0 + 7500 })
      // Appel SANS commande.
      addOcText(db, { sesId: 'ses_nocmd', msgId: 'msg_nocmd', text: 'sans commande', ts: T0 + 8000, role: 'assistant' })
      insPart.run('prt_nc0', 'msg_nocmd', 'ses_nocmd', T0 + 8001, T0 + 8001, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed' } }))
      // Commande moyenne (bornage par `chars` explicite).
      addOcTool(db, { sesId: 'ses_medcmd', msgId: 'msg_medcmd', cmd: 'B'.repeat(5000), ts: T0 + 8500 })
      // Commande destinée à être rendue VIDE (mutation de vue dans le test).
      addOcTool(db, { sesId: 'ses_emptycmd', msgId: 'msg_emptycmd', cmd: 'zzz', ts: T0 + 8700 })
      // Métadonnée `tool` à elle seule supérieure au budget total : préflight.
      addOcTool(db, { sesId: 'ses_gigameta', msgId: 'msg_gigameta', cmd: 'ls', ts: T0 + 8800, tool: 'X'.repeat(600000) })
      // Métadonnée Unicode + U+0000 : `length` TEXT s'arrête au NUL (1), mais la
      // longueur en OCTETS dépasse le budget → préflight BLOB.
      addOcTool(db, { sesId: 'ses_nulmeta', msgId: 'msg_nulmeta', cmd: 'ls', ts: T0 + 8850, tool: '😀\u0000' + 'X'.repeat(600000) })
      // Métadonnées énormes (titre) + commande à fragment réduit.
      addOcTool(db, { sesId: 'ses_tightcmd', msgId: 'msg_tightcmd', cmd: 'x'.repeat(2000), ts: T0 + 9000 })
      db.prepare('UPDATE session SET title = ? WHERE id = ?').run('M' + 'y'.repeat(523000), 'ses_tightcmd')
      // Frontière « complet SANS curseur » : petit texte + petit cmd, dernier message.
      addOcTool(db, { sesId: 'ses_boundary', msgId: 'msg_boundary', cmd: 'ls', ts: T0 + 9200, text: 'court' })
      // > 400 appels : force plusieurs lots de métadonnées ET des curseurs aux
      // frontières de lots (200 points par appel, pause page ≤ 20 000).
      addOcText(db, { sesId: 'ses_400calls', msgId: 'msg_400calls', text: null, ts: T0 + 9400, role: 'assistant' })
      for (let i = 0; i < 450; i++) {
        insPart.run(`prt_b_${String(i).padStart(4, '0')}`, 'msg_400calls', 'ses_400calls', T0 + 9401 + i, T0 + 9401 + i, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', input: { command: String(i).padStart(3, '0') + 'C'.repeat(97) }, metadata: { exitCode: 0 } } }))
      }
      // Beaucoup de petits messages + petites commandes (agrégat de page).
      for (let i = 0; i < 120; i++) {
        const mid = `msg_small_${String(i).padStart(3, '0')}`
        addOcTool(db, { sesId: 'ses_manysmall', msgId: mid, cmd: 'l'.repeat(50), ts: T0 + 10000 + i, text: 'y'.repeat(150) })
      }
      // Budget arrêté AVANT un message (offset 0) : 30 messages de 20 000 chars.
      for (let i = 0; i < 30; i++) addOcText(db, { sesId: 'ses_offset0', msgId: `msg_off_${String(i).padStart(2, '0')}`, text: 'o'.repeat(20000), ts: T0 + 11000 + i })
      // Fenêtre around/tail/ancre.
      for (let i = 0; i < 5; i++) addOcText(db, { sesId: 'ses_win', msgId: `msg_win_${i}`, text: `win ${i}`, ts: T0 + 12000 + i })
    } finally { db.close() }
  }

  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root)
})

const handlers = []
after(() => {
  for (const h of handlers) { try { h.dispose() } catch { /* best-effort */ } }
  if (PREV_PI_DIR === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = PREV_PI_DIR
  fs.rmSync(tmp, { recursive: true, force: true })
})

const cfg = { root, sources: { opencode: { path: dbPath }, pi: { path: piDir } } }
const newHandler = (opts) => { const h = createReadHandler(cfg, opts); handlers.push(h); return h }
const piSid = () => `pi:${PI_SES}`

function expectAppError (fn, code, reason = null) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    const p = appErrorPayload(e)
    assert.equal(p.code, code)
    if (reason != null) assert.equal(p.reason, reason)
    return p
  }
}

/** Points de code d'une entrée de message (texte + commandes rendues). */
function entryPoints (m) {
  let n = [...m.text].length
  for (const c of m.toolCalls || []) if (c.cmd != null) n += [...c.cmd].length
  for (const f of m.toolCallFragments || []) n += [...f.cmd].length
  return n
}

/** Enveloppe MCP RÉELLE mesurée par le handler : id + content + structuredContent. */
function envelopeBytes (out) {
  return measureSerialized({ jsonrpc: '2.0', id: 'x'.repeat(MAX_ID_STRING_CHARS), result: { content: [], structuredContent: out } })
}

/**
 * Recolle toute une session via le curseur, sans SDK. `fragments` est indexé par
 * `(id de message, callIndex)` — indispensable dès qu'une session a plusieurs
 * messages commençant chacun à callIndex 0.
 */
function readAll (handler, first, { maxPages = 500 } = {}) {
  let cursor = null
  let text = ''
  const fragments = new Map() // `${id}#${callIndex}` -> { cmd, complete }
  const ids = []
  const pagePoints = []
  let pages = 0
  let firstMessage = null
  for (;;) {
    const out = cursor ? handler({ cursor }) : handler(first)
    assert.ok(envelopeBytes(out) <= RESPONSE_BUDGET_BYTES, 'enveloppe MCP réelle ≤ budget')
    let pts = 0
    for (const m of out.messages) {
      if (!ids.length || ids[ids.length - 1] !== m.id) ids.push(m.id)
      assert.ok([...m.text].length <= MAX_READ_CHARS, 'fragment texte ≤ plafond')
      pts += entryPoints(m)
      text += m.text
      for (const c of m.toolCalls || []) if (c.cmd != null && c.callIndex != null) fragments.set(`${m.id}#${c.callIndex}`, { cmd: c.cmd, complete: true })
      for (const f of m.toolCallFragments || []) {
        assert.ok([...f.cmd].length <= MAX_READ_CHARS, 'fragment commande ≤ plafond')
        const key = `${m.id}#${f.callIndex}`
        const prev = fragments.get(key) || { cmd: '', complete: false }
        assert.equal(f.offset, [...prev.cmd].length, `offset cmd contigu (${key})`)
        fragments.set(key, { cmd: prev.cmd + f.cmd, complete: f.complete })
      }
    }
    assert.ok(pts <= MAX_READ_CHARS, `agrégat de page ≤ ${MAX_READ_CHARS} points`)
    pagePoints.push(pts)
    if (firstMessage === null && out.messages.length) firstMessage = out.messages[0]
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (pages > maxPages) assert.fail('trop de pages')
  }
  return { text, fragments, ids, pages, pagePoints, firstMessage }
}

// ── Défaut corrigé : commande géante Pi/OpenCode recolle SANS PERTE ──────────

test('Pi : commande 614 400 chars, texte vide, recolle exactement puis message suivant atteint', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: piSid(), full: true }, { maxPages: 120 })
  assert.equal(r.firstMessage.text, '', 'message à commande seule : texte vide')
  assert.equal(r.firstMessage.complete, false, 'message incomplet tant que la commande n’est pas finie')
  const call = r.fragments.get(`${r.ids[0]}#0`)
  assert.ok(call, 'appel retrouvé')
  assert.equal(call.cmd, BIG_CMD, 'commande Pi recolle exactement')
  assert.equal(call.complete, true)
  assert.ok(r.pages > 2, 'fragmentation effective')
  assert.ok(r.ids.length >= 2, 'message suivant retrouvé')
  assert.equal(r.pagePoints.every((p) => p <= MAX_READ_CHARS), true)
})

test('OpenCode : commande 614 400 chars recolle exactement + message suivant', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: 'ses_oc_big', full: true }, { maxPages: 120 })
  const call = r.fragments.get(`${r.ids[0]}#0`)
  assert.equal(call.cmd, BIG_CMD, 'commande OpenCode recolle exactement')
  assert.equal(call.complete, true)
  assert.ok(r.ids.length >= 2, 'message suivant atteint')
})

test('texte long + commande géante : texte ET commande recollent sans perte', () => {
  const handler = newHandler()
  let cursor = null
  let text = ''
  const calls = new Map()
  let pages = 0
  for (;;) {
    const out = cursor ? handler({ cursor }) : handler({ session: 'ses_mix', full: true })
    for (const m of out.messages) {
      text += m.text
      for (const c of m.toolCalls || []) if (c.cmd != null) calls.set(`${m.id}#${c.callIndex}`, c.cmd)
      for (const f of m.toolCallFragments || []) {
        const key = `${m.id}#${f.callIndex}`
        calls.set(key, (calls.get(key) || '') + f.cmd)
      }
    }
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (pages > 300) assert.fail('trop de pages')
  }
  assert.ok(text.includes(TEXT_LONG), 'texte long recolle')
  assert.equal([...calls.values()].find((c) => c === BIG_CMD), BIG_CMD, 'commande géante recolle')
})

test('plusieurs appels : petits autour d’un gros, tous retrouvés', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: 'ses_multi', full: true })
  assert.equal(r.fragments.get(`${r.ids[0]}#0`).cmd, 'petit-a')
  assert.equal(r.fragments.get(`${r.ids[0]}#1`).cmd, BIG_CMD)
  assert.equal(r.fragments.get(`${r.ids[0]}#2`).cmd, 'file: x.txt')
  for (const k of [0, 1, 2]) assert.equal(r.fragments.get(`${r.ids[0]}#${k}`).complete, true)
})

test('grand nombre de petits appels : tous rendus, aucun budget_exhausted', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: 'ses_manycalls' })
  const cmds = [...r.fragments.entries()].filter(([k]) => k.startsWith(`${r.ids[0]}#`)).map(([, v]) => v.cmd).sort()
  const want = Array.from({ length: 40 }, (_, i) => `file: f${i}.txt`).sort()
  assert.deepEqual(cmds, want)
})

// ── Unicode + NUL : exactitude octet/point de code ──────────────────────────

test('commande Unicode + U+0000 : recolle exactement (emoji, NUL conservés)', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: 'ses_nulcmd', full: true }, { maxPages: 80 })
  const call = r.fragments.get(`${r.ids[0]}#0`)
  assert.equal(call.cmd, BIG_NUL, 'commande avec NUL recolle exactement')
  assert.ok(call.cmd.includes('\u0000'))
  assert.ok(call.cmd.includes('😀'))
})

test('commande Unicode (accents/emoji) recolle sans perte', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: `pi:${PI_NEXT_SES}`, full: true }, { maxPages: 60 })
  assert.equal(r.fragments.get(`${r.ids[0]}#0`).cmd, BIG_UNI)
})

test('texte long seul : offsets contigus et recollement exact (comportement préservé)', () => {
  const handler = newHandler()
  let cursor = null
  let text = ''
  let pages = 0
  for (;;) {
    const out = cursor ? handler({ cursor }) : handler({ session: 'ses_mix', around: 'msg_mix_text', ctx: 0, full: true })
    for (const m of out.messages) {
      assert.equal(m.offset, [...text].length, 'offset globaux contigus pour le message unique')
      text += m.text
    }
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (pages > 20) assert.fail('trop de pages')
  }
  assert.equal(text, TEXT_LONG, 'texte long recolle exactement')
  assert.equal(pages, 4, '60001 points / 20000 ⇒ 4 pages')
})

test('texte Unicode + U+0000 : recolle exactement (NUL et emoji conservés)', () => {
  const handler = newHandler()
  let cursor = null
  let text = ''
  let pages = 0
  for (;;) {
    const out = cursor ? handler({ cursor }) : handler({ session: 'ses_nultext', full: true })
    for (const m of out.messages) text += m.text
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (pages > 80) assert.fail('trop de pages')
  }
  assert.equal(text, BIG_NUL, 'texte NUL recolle exactement')
  assert.ok(text.includes('\u0000') && text.includes('😀'))
})

test('`complete` n’est VRAI qu’une fois texte ET commande complets', () => {
  const handler = newHandler()
  const p1 = handler({ session: 'ses_oc_big', full: true })
  const m1 = p1.messages[0]
  assert.equal(m1.textComplete, true, 'texte vide donc complet')
  assert.equal(m1.toolCallsComplete, false, 'commande encore partielle')
  assert.equal(m1.complete, false, 'message NON complet')
  assert.ok(m1.toolCallFragments && m1.toolCallFragments.length >= 1)
  let cursor = p1.truncated.nextCursor
  let guard = 0
  let sawCompleteCall = false
  for (;;) {
    const out = handler({ cursor })
    for (const m of out.messages) if (m.id === m1.id && m.toolCallsComplete === true) sawCompleteCall = true
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (++guard > 200) assert.fail('trop de pages')
  }
  assert.ok(sawCompleteCall, 'le message devient complet quand la commande est finie')
})

test('dimensions : `text` seulement si texte partiel ; `toolCalls` si commande partielle', () => {
  const handler = newHandler()
  const cmd = handler({ session: 'ses_oc_big', full: true })
  const dims = cmd.truncated.dimensions.map((d) => d.dimension)
  assert.ok(dims.includes('toolCalls'), 'dimension commandes explicite')
  assert.ok(!dims.includes('text'), 'texte vide complet ⇒ pas de dimension texte')
  const txt = handler({ session: 'ses_mix', around: 'msg_mix_text', ctx: 0, chars: 100 })
  const dims2 = txt.truncated.dimensions.map((d) => d.dimension)
  assert.ok(dims2.includes('text'), 'texte partiel ⇒ dimension texte')
})

// ── Bornes de page (20 000 points), lots de métadonnées, frontières ──────────

test('plafond PAR PAGE : 30 messages de 20 000 points ⇒ 30 pages d’un message', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: 'ses_offset0', full: true }, { maxPages: 40 })
  assert.equal(r.pages, 30, 'un message par page (20 000 points/page)')
  assert.equal(r.ids.length, 30)
  assert.equal(new Set(r.ids).size, 30, 'aucun doublon')
  assert.equal(r.text.length, 30 * 20000, 'recollement exact')
  assert.ok(r.pagePoints.every((p) => p <= MAX_READ_CHARS))
})

test('beaucoup de petits messages + commandes : agrégat de page ≤ 20 000 points', () => {
  const handler = newHandler()
  const r = readAll(handler, { session: 'ses_manysmall', full: true })
  assert.ok(r.pages >= 2, 'plusieurs pages (24000 points)')
  assert.equal(r.ids.length, 120)
  assert.equal(r.fragments.size, 120, 'une commande par message')
  assert.ok(r.pagePoints.every((p) => p <= MAX_READ_CHARS), 'chaque page sous le plafond')
  assert.equal(r.pagePoints.reduce((a, b) => a + b, 0), 120 * 200)
})

test('> 400 appels : tous rendus, curseurs aux frontières de lots de métadonnées', () => {
  const handler = newHandler()
  const positions = []
  let cursor = null
  const cmds = new Map()
  let pages = 0
  for (;;) {
    const out = cursor ? handler({ cursor }) : handler({ session: 'ses_400calls', full: true })
    for (const m of out.messages) {
      for (const c of m.toolCalls || []) if (c.cmd != null) cmds.set(c.callIndex, c.cmd)
      for (const f of m.toolCallFragments || []) cmds.set(f.callIndex, (cmds.get(f.callIndex) || '') + f.cmd)
    }
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    const state = handler.cursors.get(cursor)
    positions.push(state.position.callIndex)
    if (pages > 20) assert.fail('trop de pages')
  }
  assert.equal(cmds.size, 450, '450 appels rendus')
  for (let i = 0; i < 450; i++) assert.equal(cmds.get(i), String(i).padStart(3, '0') + 'C'.repeat(97), `appel ${i}`)
  assert.deepEqual(positions, [200, 400], 'curseurs aux frontières de lots (200, 400)')
})

// ── Nominal, absence/vide de commande, curseurs, budget ─────────────────────

test('nominal petites commandes : préservé dans `toolCalls`, sans fragmentation', () => {
  const handler = newHandler()
  const out = handler({ session: 'ses_nocmd' })
  const m = out.messages.find((x) => x.toolCalls.length > 0)
  assert.ok(m)
  assert.equal(m.toolCalls[0].callIndex, 0)
  assert.equal(m.toolCallsComplete, true)
  assert.equal(m.complete, true)
  assert.equal(m.textComplete, true)
  assert.equal(m.toolCallFragments, undefined, 'aucune fragmentation pour une commande absente')
})

test('appel SANS commande : `cmd` absent (jamais inventé)', () => {
  const handler = newHandler()
  const out = handler({ session: 'ses_nocmd' })
  const m = out.messages.find((x) => x.toolCalls.length > 0)
  assert.equal('cmd' in m.toolCalls[0], false, 'aucun champ cmd inventé')
  assert.equal(m.toolCalls[0].tool, 'read')
})

test('commande réellement VIDE : rendue telle quelle, sans fragmentation', () => {
  const vp = path.join(root, 'index.db')
  const db = new Database(vp)
  try { db.prepare("UPDATE events SET json = json_set(json, '$.toolCalls[0].cmd', '') WHERE id = 'msg_emptycmd'").run() } finally { db.close() }
  const handler = newHandler()
  const out = handler({ session: 'ses_emptycmd' })
  const m = out.messages.find((x) => x.toolCalls.length > 0)
  assert.ok(m)
  assert.equal(m.toolCalls[0].cmd, '', 'commande vide conservée')
  assert.equal(m.toolCallsComplete, true)
  assert.equal(m.complete, true)
  assert.equal(m.toolCallFragments, undefined)
})

test('préflight : métadonnée `tool` > budget ⇒ erreur bornée AVANT transfert', () => {
  const handler = newHandler()
  expectAppError(() => handler({ session: 'ses_gigameta' }), 'internal', 'budget_exhausted')
})

test('préflight : métadonnée Unicode + U+0000 > budget (octets) ⇒ refus AVANT transfert', () => {
  const handler = newHandler()
  // `length` TEXT ne verrait que 1 point (avant le NUL) ; les OCTETS dépassent le budget.
  expectAppError(() => handler({ session: 'ses_nulmeta' }), 'internal', 'budget_exhausted')
})

test('`chars` explicite : chaque fragment de commande reste borné', () => {
  const handler = newHandler()
  let cursor = null
  let pages = 0
  for (;;) {
    const out = cursor ? handler({ cursor }) : handler({ session: 'ses_medcmd', chars: 100 })
    for (const m of out.messages) for (const f of m.toolCallFragments || []) assert.ok([...f.cmd].length <= 100, 'fragment ≤ chars')
    pages++
    if (!out.truncated || !out.truncated.nextCursor) break
    cursor = out.truncated.nextCursor
    if (pages > 120) assert.fail('trop de pages')
  }
  assert.ok(pages >= 2)
})

test('curseur opaque : aucune commande ni texte dans l’état', () => {
  const handler = newHandler()
  const out = handler({ session: 'ses_oc_big', full: true })
  const cursor = out.truncated.nextCursor
  assert.ok(cursor)
  const state = handler.cursors.get(cursor)
  assert.ok(state, 'état conservé')
  const s = JSON.stringify(state)
  assert.ok(!s.includes('AAAA'), 'aucun contenu de commande dans le curseur')
  assert.ok(state.position && Number.isInteger(state.position.callIndex))
  assert.ok(!('text' in state.position) && !('cmd' in state.position))
})

test('génération changée : curseur stale, aucun mélange', () => {
  const handler = newHandler()
  const out = handler({ session: 'ses_oc_big', full: true })
  const cursor = out.truncated.nextCursor
  index(root)
  expectAppError(() => handler({ cursor }), 'stale_cursor')
})

test('curseur d’un autre handler : invalid_cursor', () => {
  const h1 = newHandler()
  const out = h1({ session: 'ses_oc_big', full: true })
  expectAppError(() => newHandler()({ cursor: out.truncated.nextCursor }), 'invalid_cursor')
})

test('around / tail / at : fenêtre inchangée', () => {
  const handler = newHandler()
  const around = handler({ session: 'ses_win', around: 'msg_win_2', ctx: 1 })
  assert.deepEqual(around.messages.map((m) => m.id), ['msg_win_1', 'msg_win_2', 'msg_win_3'])
  const tail = handler({ session: 'ses_win', tail: 2 })
  assert.deepEqual(tail.messages.map((m) => m.id), ['msg_win_3', 'msg_win_4'])
  const at = handler({ session: 'ses_win', at: 'msg_win_1' })
  assert.deepEqual(at.messages.map((m) => m.id), ['msg_win_0', 'msg_win_1'])
})

test('budget serré : métadonnée énorme + commande fragmentée à 1 point minimum', () => {
  const handler = newHandler()
  const out = handler({ session: 'ses_tightcmd', full: true })
  assert.ok(out.messages.length >= 1)
  const m = out.messages[0]
  const frag = (m.toolCallFragments || [])[0]
  assert.ok(frag, 'commande coupée dans toolCallFragments (jamais dans toolCalls)')
  const len = [...frag.cmd].length
  assert.ok(len >= 1, 'au moins 1 point rendu (progrès garanti)')
  assert.ok(len < 2000, 'fragment RÉDUIT sous le plafond, pas la commande entière')
  assert.equal(m.complete, false)
  assert.equal(m.textComplete, true)
  assert.equal(m.toolCallsComplete, false)
  assert.ok(out.truncated && out.truncated.nextCursor, 'suite par curseur')
})

test('frontière : message + petit cmd tient SANS curseur (pas de refus sur fausse continuation)', () => {
  const handler = newHandler()
  const vp = path.join(root, 'index.db')
  const setTitle = (n) => {
    const db = new Database(vp)
    try { db.prepare("UPDATE sessions SET title = ?, json = json_set(json, '$.title', ?) WHERE id = 'ses_boundary'").run('T'.repeat(n), 'T'.repeat(n)) } finally { db.close() }
  }
  const probe = (n) => {
    setTitle(n)
    try {
      const out = handler({ session: 'ses_boundary', full: true })
      const m = out.messages[0]
      return { complete: m ? m.complete : null, noCursor: !out.truncated, bytes: envelopeBytes(out) }
    } catch (e) { return { err: appErrorPayload(e).reason } }
  }
  // Plus grand titre où le message est COMPLET (recherche binaire). Le mtime de la
  // vue fait varier l'enveloppe de quelques octets entre deux écritures : on
  // re-scanne vers le bas pour retenir le plus grand titre COMPLET observé.
  let lo = 500000
  let hi = 525000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (probe(mid).complete === true) lo = mid + 1
    else hi = mid
  }
  let best = null
  for (let d = 0; d <= 8 && !best; d++) {
    const r = probe(lo - 1 - d)
    if (r.complete === true && r.noCursor === true) best = { n: lo - 1 - d, bytes: r.bytes }
  }
  assert.ok(best, 'titre proche de la frontière : message complet émis SANS curseur')
  // Marge résiduelle très inférieure au coût d'un curseur + dims (≈200 o) : sans
  // essai du VRAI candidat complet, la sonde d'une fausse continuation aurait refusé.
  assert.ok(best.bytes > RESPONSE_BUDGET_BYTES - 240, `proche du budget (marge ${RESPONSE_BUDGET_BYTES - best.bytes})`)
  assert.notEqual(probe(best.n + 40).complete, true, 'au-delà : plus complet (jamais présenté comme tel)')
})

// ── Instrumentation SQL : extraction BORNÉE, lots LIMITÉS ───────────────────

test('SQL : jamais le tableau `toolCalls` entier ; métadonnées par lots LIMITÉS', () => {
  const sqls = []
  const realPrepare = Database.prototype.prepare
  Database.prototype.prepare = function (sql, ...rest) { sqls.push(sql); return realPrepare.call(this, sql, ...rest) }
  try {
    const handler = newHandler()
    const out = handler({ session: 'ses_oc_big', chars: 400 })
    assert.ok(out.messages.length >= 1)
    assert.ok(out.truncated.nextCursor)
  } finally {
    Database.prototype.prepare = realPrepare
  }
  assert.ok(!sqls.some((s) => /json_extract\(\s*e\.json\s*,\s*'\$\.toolCalls'\s*\)/.test(s)), 'jamais le tableau toolCalls entier')
  assert.ok(!sqls.some((s) => /SELECT\s+json\s+FROM\s+events/i.test(s)), 'jamais SELECT json')
  // Les métadonnées d'appel sont chargées par lots explicitement LIMITÉS.
  const metaQueries = sqls.filter((s) => s.includes('j.key AS callIndex'))
  assert.ok(metaQueries.length > 0, 'requête de métadonnées utilisée')
  assert.ok(metaQueries.every((s) => /LIMIT @limit/.test(s)), 'chaque lot de métadonnées est LIMITÉ')
  assert.ok(sqls.some((s) => s.includes('json_each(e.json')), 'membres extraits par json_each')
  assert.ok(sqls.some((s) => /substr\(json_extract\(e\.json/.test(s)), 'commande extraite par fragment SQL')
})

test('CursorStore : bornes et TTL inchangés', () => {
  assert.throws(() => new CursorStore({ max: 0 }), /max/)
  assert.throws(() => new CursorStore({ ttlMs: 0 }), /ttlMs/)
  assert.equal(typeof CURSOR_TTL_MS, 'number')
})
