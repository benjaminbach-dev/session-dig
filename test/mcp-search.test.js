// Handler `sdig_search` (sous-lot search B). Fixtures 100 % synthétiques ; la
// source pi est TOUJOURS sous le tmp du test (jamais ~/.pi). Aucun corpus privé,
// aucun port de production : le test bout-en-bout utilise le port OS éphémère.
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
import {
  createSearchHandler,
  validateSearchInput,
  searchOutputSchema,
  appErrorPayload,
  measureSerialized,
  RESPONSE_BUDGET_BYTES,
  createMcpTestServer
} from '../src/mcp/index.js'
import { PI_FIDELITY_LIMITS, PI_FIDELITY_NOTE } from '../src/format.js'

const SECRET = 'sk-live-SUPER-SECRET-42'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-search-'))
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi-un')
const piAbsent = process.env.SESSION_DIG_PI_DIR
const dbHuge = path.join(tmp, 'huge.db')
const rootHuge = path.join(tmp, 'corpus-huge')

const EQUAL_TEXT = 'zzz egal multi source motif'
const PI_EQUAL_COUNT = 60
const OC_EQUAL_COUNT = 10
const BUDGET_COUNT = 50
const BUDGET_FILLER = 'z'.repeat(30000)
// Voisins de contexte non-matchants, assez gros pour exercer le budget restant.
const CONTEXT_FILLER = 'q'.repeat(8000)
const CHARS_TEXT = 'hugequeryword ' + '🙂'.repeat(30000) + ' ' + 'é'.repeat(60000)
const PI_TERM = 'termepiunique'
const PI_TITLE = 'TitrePiUnique'

function addOpencodeMessage (db, { sesId, msgId, text, ts, title = null }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sesId, 'p', `/root/${sesId}`, title ?? sesId, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, sesId, ts, ts, JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'x', modelID: 'y' } }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
}

function addOpencodeToolMessage (db, { sesId, msgId, command, ts, title = null }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sesId, 'p', `/root/${sesId}`, title ?? sesId, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, sesId, ts, ts, JSON.stringify({ role: 'assistant', agent: 'build', model: { providerID: 'x', modelID: 'y' } }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command }, output: 'ok\n', metadata: { exitCode: 0 } } }))
}

const cfg = (r, sources) => ({ root: r, sources })
const opencodeOnly = (r = root) => cfg(r, { opencode: { path: dbPath }, pi: { path: piAbsent } })
const mixed = cfg(root, { opencode: { path: dbPath }, pi: { path: piDir } })

function call (handler, raw) {
  const v = validateSearchInput(raw)
  return handler(v.value, v.adaptations)
}

function envelopeBytes (out) {
  return measureSerialized({ jsonrpc: '2.0', id: 'x'.repeat(128), result: { content: [], structuredContent: out } })
}

function expectAppError (fn, code, reason = null) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    const payload = appErrorPayload(e)
    assert.equal(payload.code, code)
    if (reason != null) assert.equal(payload.reason, reason)
    assert.ok(!JSON.stringify(payload).includes(tmp), 'aucun chemin local dans l’erreur')
    assert.ok(!JSON.stringify(payload).includes(SECRET), 'aucun contenu dans l’erreur')
    return payload
  }
}

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    for (let i = 0; i < OC_EQUAL_COUNT; i++) {
      addOpencodeMessage(db, { sesId: 'ses_eq', msgId: `msg_eq_${String(i).padStart(2, '0')}`, text: EQUAL_TEXT, ts: T0 + 100000 + i, title: 'Égal multi-source' })
    }
    for (let i = 0; i < BUDGET_COUNT; i++) {
      const base = T0 + 200000 + i * 10
      const pad = String(i).padStart(2, '0')
      addOpencodeMessage(db, { sesId: 'ses_budget', msgId: `msg_bs_${pad}`, text: `contexte avant ${CONTEXT_FILLER}`, ts: base, title: 'Budget' })
      addOpencodeMessage(db, { sesId: 'ses_budget', msgId: `msg_b_${pad}`, text: `budgetword ${BUDGET_FILLER}`, ts: base + 1, title: 'Budget' })
      addOpencodeMessage(db, { sesId: 'ses_budget', msgId: `msg_ba_${pad}`, text: `contexte après ${CONTEXT_FILLER}`, ts: base + 2, title: 'Budget' })
    }
    addOpencodeMessage(db, { sesId: 'ses_chars', msgId: 'msg_chars', text: CHARS_TEXT, ts: T0 + 300000, title: 'Caractères' })
    // Commande SEULE (texte vide) et textes contenant une ellipse littérale.
    addOpencodeToolMessage(db, { sesId: 'ses_cmd', msgId: 'msg_cmd', command: 'commandword --flag valeur', ts: T0 + 350000, title: 'Commande' })
    addOpencodeMessage(db, { sesId: 'ses_ell', msgId: 'msg_ell_short', text: 'avant … ellipsisshort … après', ts: T0 + 360000, title: 'Ellipses courtes' })
    addOpencodeMessage(db, { sesId: 'ses_ell', msgId: 'msg_ell_long', text: 'debut ellipsislong ' + 'mot '.repeat(60) + '… ' + 'fin '.repeat(60), ts: T0 + 360100, title: 'Ellipses longues' })
  } finally { db.close() }

  const uuid = fakeUuid()
  const piLines = [
    sessionLine(uuid, T0, '/root/pi-un'),
    infoLine(T0 + 10, PI_TITLE, 'infp'),
    messageLine(T0 + 1000, { role: 'user', content: [{ type: 'text', text: `message pi ${PI_TERM}` }], timestamp: T0 + 1000 }),
    messageLine(T0 + 2000, { role: 'assistant', content: [{ type: 'text', text: 'réponse pi de contexte' }], timestamp: T0 + 2000 })
  ]
  // 60 messages pi au texte IDENTIQUE : rangs égaux avec les 10 opencode.
  for (let i = 0; i < PI_EQUAL_COUNT; i++) {
    piLines.push(messageLine(T0 + 10000 + i, { role: 'user', content: [{ type: 'text', text: EQUAL_TEXT }], timestamp: T0 + 10000 + i }))
  }
  writePiSession(piDir, 'proj-a', 'ses_pi.jsonl', piLines)
  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root)

  buildFixtureDb(dbHuge)
  const dbH = new Database(dbHuge)
  try {
    addOpencodeMessage(dbH, { sesId: 'ses_giant', msgId: 'msg_giant', text: 'budgetword normal', ts: T0 + 400000, title: 'budgetword ' + 'x'.repeat(600000) })
  } finally { dbH.close() }
  await ingest({ root: rootHuge, db: dbHuge, source: 'opencode' })
  index(rootHuge)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ── Top-k, total honnête, ordre ─────────────────────────────────────────────

test('> 50 scores égaux multi-sources : top-k stable, total null (sélection bornée)', () => {
  const out = call(createSearchHandler(mixed), { query: 'zzz', limit: 50 })
  assert.ok(searchOutputSchema.safeParse(out).success)
  assert.equal(out.count, 50)
  assert.equal(out.topK, 50)
  assert.equal(out.total, null, 'total inconnu quand la limite borne la sélection')
  assert.equal(new Set(out.hits.map((h) => h.score)).size, 1, 'scores égaux')
  // Départage binaire déjà appliqué par le moteur : la sélection est triée par id complet.
  const ids = out.hits.map((h) => h.ref.messageId)
  assert.ok(ids.every((x) => typeof x === 'string'))
  assert.deepEqual(ids, [...ids].sort(), 'ids en ordre binaire sur scores égaux')
  assert.ok(out.groups.length >= 1)
})

test('moins de hits que la limite : total exact connu (pas de fausse exhaustivité)', () => {
  const out = call(createSearchHandler(mixed), { query: 'proxy 461' })
  assert.equal(out.count, out.total)
  assert.ok(out.count < out.topK)
})

test('adaptation de limite : plafond appliqué et signalé', () => {
  const out = call(createSearchHandler(mixed), { query: 'zzz', limit: 999, ctx: 9 })
  assert.equal(out.topK, 50)
  assert.ok(out.adaptations.some((a) => a.field === 'limit' && a.applied === 50))
  assert.ok(out.adaptations.some((a) => a.field === 'ctx' && a.applied === 5))
  assert.ok(!Object.hasOwn(out, 'nextCursor'))
})

// ── Filtres source / titre / agent ──────────────────────────────────────────

test('filtre source : pi seulement, opencode seulement, source inconnue = zéro hit', () => {
  const pi = call(createSearchHandler(mixed), { query: PI_TERM, source: 'pi' })
  assert.equal(pi.hits.length, 1)
  assert.equal(pi.hits[0].source, 'pi')
  const oc = call(createSearchHandler(mixed), { query: 'proxy', source: 'opencode' })
  assert.ok(oc.hits.length >= 1)
  assert.ok(oc.hits.every((h) => h.source === 'opencode'))
  const unknown = call(createSearchHandler(mixed), { query: 'proxy', source: 'martien' })
  assert.equal(unknown.hits.length, 0)
  assert.equal(unknown.total, 0)
})

test('agent exact et préfixe de session littéral (moteur partagé)', () => {
  const byAgent = call(createSearchHandler(mixed), { query: 'proxy', agent: 'build' })
  assert.ok(byAgent.hits.length >= 1)
  assert.ok(byAgent.hits.every((h) => h.agent === 'build'))
  // pi v0 porte agent null : un filtre non nul exclut tous ses messages.
  assert.equal(call(createSearchHandler(mixed), { query: PI_TERM, agent: 'build' }).hits.length, 0)
  const prefix = call(createSearchHandler(mixed), { query: 'proxy', session: 'ses_fix' })
  assert.ok(prefix.hits.length >= 1)
  assert.ok(prefix.hits.every((h) => h.ref.sessionId.startsWith('ses_fix')))
})

test('titre seul : kind title, messageId null, référence de session, groupe', () => {
  const out = call(createSearchHandler(mixed), { query: 'titrepiunique' })
  assert.equal(out.hits.length, 1)
  const h = out.hits[0]
  assert.equal(h.kind, 'title')
  assert.equal(h.ref.messageId, null)
  assert.ok(out.groups.some((g) => g.sessionId === h.ref.sessionId && g.hitRefs.some((r) => r.messageId === null)))
})

test('fidélité pi : présente sur données pi rendues, ABSENTE pour opencode et sans hit', () => {
  const pi = call(createSearchHandler(mixed), { query: PI_TERM })
  const fidelity = { source: 'pi', general: true, limits: [...PI_FIDELITY_LIMITS], note: PI_FIDELITY_NOTE }
  assert.deepEqual(pi.hits[0].fidelity, fidelity)
  assert.deepEqual(pi.groups.find((g) => g.sessionId === pi.hits[0].ref.sessionId).fidelity, fidelity)

  const oc = call(createSearchHandler(mixed), { query: 'proxy' })
  assert.ok(oc.hits.every((h) => h.fidelity === undefined))
  assert.ok(oc.groups.every((g) => g.fidelity === undefined))
  assert.ok(!JSON.stringify(oc).includes('"fidelity"'))

  const none = call(createSearchHandler(mixed), { query: 'sourceinconnuexyz' })
  assert.equal(none.hits.length, 0)
  assert.ok(!JSON.stringify(none).includes('"fidelity"'))
})

// ── Voisins bornés, fusion/dedup ────────────────────────────────────────────

test('ctx > 0 : voisins bornés, dédupliqués par message, références read', () => {
  const out = call(createSearchHandler(mixed), { query: 'zzz', limit: 50, ctx: 1 })
  assert.ok(searchOutputSchema.safeParse(out).success)
  const keys = out.neighbors.map((n) => `${n.ref.sessionId}\u0000${n.ref.messageId}`)
  assert.equal(new Set(keys).size, keys.length, 'aucun voisin dupliqué')
  for (const n of out.neighbors) {
    assert.ok(n.ref.sessionId && n.ref.messageId)
    assert.ok(n.forRef.sessionId)
    assert.ok(typeof n.excerpt.text === 'string')
  }
  // Pas plus de 2*ctx*(hits non-titres) voisins bruts.
  assert.ok(out.neighbors.length <= 2 * 1 * out.count)
})

// ── Extraits bornés (token énorme / emoji / frontières) ─────────────────────

test('extrait borné : token énorme + emoji, aucun ANSI, bien formé, coupure signalée', () => {
  const out = call(createSearchHandler(opencodeOnly()), { query: 'hugequeryword' })
  assert.ok(searchOutputSchema.safeParse(out).success)
  const h = out.hits[0]
  assert.ok([...h.excerpt.text].length <= 20000)
  assert.equal(h.excerpt.truncated, true)
  assert.ok(h.excerpt.text.isWellFormed(), 'aucun demi-surrogate')
  assert.ok(!h.excerpt.text.includes('\uFFFD'))
  assert.ok(!/\x1b\[[0-9;]*m/.test(h.excerpt.text), 'aucun ANSI dans la sortie')
})

// ── Extrait intégral vs fenêtre FTS (indicateur SQL exact, pas de longueur) ──

test('extrait intégral : texte court, même avec ellipse littérale, => truncated false', () => {
  const out = call(createSearchHandler(opencodeOnly()), { query: 'ellipsisshort' })
  assert.equal(out.hits.length, 1)
  assert.equal(out.hits[0].excerpt.truncated, false, 'snippet == texte établi côté SQL')
  assert.ok(out.hits[0].excerpt.text.includes('…'), 'l’ellipse littérale est conservée')
})

test('fenêtre FTS omettant du texte (ellipse littérale) => truncated true, jamais complète', () => {
  const out = call(createSearchHandler(opencodeOnly()), { query: 'ellipsislong' })
  assert.equal(out.hits.length, 1)
  assert.equal(out.hits[0].excerpt.truncated, true)
  assert.ok(out.hits[0].excerpt.text.length < 500, 'fenêtre bornée')
})

test('hit commande seule (texte vide) : extrait de snipCmd identifié, pas de texte vide', () => {
  const out = call(createSearchHandler(opencodeOnly()), { query: 'commandword' })
  assert.equal(out.hits.length, 1)
  const h = out.hits[0]
  assert.equal(h.excerptKind, 'cmd')
  assert.ok(h.excerpt.text.includes('commandword'), 'extrait utilisable issu de la commande')
  assert.ok(!/\x1b\[[0-9;]*m/.test(h.excerpt.text), 'aucun ANSI')
  assert.ok(h.ref.sessionId && h.ref.messageId, 'référence read conservée')
})

// ── Budget : hits prioritaires, puis voisins ────────────────────────────────

test('budget : hits prioritaires sur les voisins, coupures exactes, enveloppe tenue', () => {
  const out = call(createSearchHandler(mixed), { query: 'budgetword', limit: 50, ctx: 5 })
  assert.ok(searchOutputSchema.safeParse(out).success)
  assert.ok(envelopeBytes(out) <= RESPONSE_BUDGET_BYTES, 'enveloppe dans le budget')
  assert.ok(out.count > 0, 'les hits sont rendus en priorité')
  const dims = out.truncated?.dimensions ?? []
  const excerptDim = dims.find((d) => d.dimension === 'excerpt_chars')
  assert.ok(excerptDim && excerptDim.retained < excerptDim.total, 'quantité RÉELLE de texte affichée < total des extraits (agrégat exact)')
  assert.ok(out.adaptations.some((a) => a.field === 'excerpt_chars' && a.applied < a.requested), 'plafond d’extrait ajusté signalé en adaptation')
  assert.equal(out.count, 50, 'les hits restent rendus (texte réduit AVANT la sélection)')
  assert.equal(dims.some((d) => d.dimension === 'hits'), false, 'aucun hit coupé quand réduire le texte suffit')
  assert.ok(out.hits.every((h) => h.excerpt.truncated === true), 'chaque extrait coupé est signalé')
  const neighborDim = dims.find((d) => d.dimension === 'neighbors')
  assert.ok(neighborDim && neighborDim.retained < neighborDim.total, 'voisins remplissent le budget RESTANT puis sont coupés')
  assert.equal(out.neighbors.length, neighborDim.retained)
  assert.ok(out.hits.every((h) => [...h.excerpt.text].length <= 20000))
  if (out.truncated) {
    for (const d of out.truncated.dimensions) {
      assert.ok(d.retained >= 0)
      assert.ok(d.total === null || d.total >= d.retained, `total >= retained pour ${d.dimension}`)
    }
  }
})

// ── Erreurs closes, sans fuite ──────────────────────────────────────────────

test('requête sans terme exploitable => invalid_params (jamais internal)', () => {
  const handler = createSearchHandler(mixed)
  for (const q of ['comment la the of', '!!!']) {
    expectAppError(() => call(handler, { query: q }), 'invalid_params')
  }
})

test('vue indisponible => view_unavailable à raison fermée, sans chemin', () => {
  const empty = path.join(tmp, 'racine-vide')
  fs.mkdirSync(empty, { recursive: true })
  expectAppError(() => call(createSearchHandler(opencodeOnly(empty)), { query: 'proxy' }), 'view_unavailable', 'missing_view')
})

test('métadonnée de groupe hors budget => erreur bornée budget_exhausted, sans fuite du titre', () => {
  const payload = expectAppError(() => call(createSearchHandler(opencodeOnly(rootHuge)), { query: 'budgetword' }), 'internal', 'budget_exhausted')
  assert.ok(!JSON.stringify(payload).includes('xxxx'))
})

// ── Client MCP HTTP officiel (port OS éphémère) ─────────────────────────────

function rawToolCall (port, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sdig_search', arguments: args } })
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
        'content-length': Buffer.byteLength(body)
      },
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

test('client MCP réél : search rendu, budget d’enveloppe respecté sur le fil', async () => {
  const handlers = {
    sdig_search: createSearchHandler(mixed),
    sdig_read: async () => ({}),
    sdig_status: async () => ({ counts: { sessions: 0, events: 0 }, rawFiles: null, rawReferences: 0, view: null, viewNote: null, sources: {}, freshness: { sources: {}, indexMtime: null, corpusVersion: null } })
  }
  const srv = createMcpTestServer({ handlers })
  await srv.start()
  try {
    assert.notEqual(srv.address().port, 18767)
    const client = new Client({ name: 'mcp-search-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`))
    await client.connect(transport)
    try {
      const res = await client.callTool({ name: 'sdig_search', arguments: { query: 'proxy 461' } })
      assert.notEqual(res.isError, true)
      assert.ok(searchOutputSchema.safeParse(res.structuredContent).success)
      assert.equal(res.structuredContent.hits[0].ref.sessionId, 'ses_fix1')
      const bad = await client.callTool({ name: 'sdig_search', arguments: { query: 'proxy', cursor: 'x' } })
      assert.equal(bad.isError, true)
      assert.equal(JSON.parse(bad.content[0].text).code, 'invalid_params')
    } finally {
      await client.close()
    }
    // Enveloppe réelle sur le fil pour l'appel lourd : jamais au-dessus du budget.
    const heavy = await rawToolCall(srv.address().port, { query: 'budgetword', limit: 50, ctx: 5 })
    assert.equal(heavy.status, 200)
    assert.ok(Buffer.byteLength(heavy.text) <= RESPONSE_BUDGET_BYTES, `enveloppe ${Buffer.byteLength(heavy.text)} > ${RESPONSE_BUDGET_BYTES}`)
  } finally {
    await srv.close()
  }
})
