// Handler `sdig_status` (sous-lot status, M3 partiel). Fixtures 100 % synthétiques ;
// la source pi est TOUJOURS sous le tmp du test (jamais ~/.pi). Aucun corpus
// privé, aucun port de production : le test bout-en-bout utilise le port OS
// éphémère de `createMcpTestServer`.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import { viewPath } from '../src/view.js'
import {
  createStatusHandler,
  statusOutputSchema,
  createMcpTestServer,
  appErrorPayload
} from '../src/mcp/index.js'

const SECRET = 'sk-live-SUPER-SECRET-42'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-status-'))
// Hermétique : le chemin pi par défaut ne doit JAMAIS tomber sur ~/.pi.
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const rootPi = path.join(tmp, 'corpus-pi')
const piDir = path.join(tmp, 'pi-un')
const piAbsent = process.env.SESSION_DIG_PI_DIR

const statePathOf = (r) => path.join(r, 'state.json')
const viewPathOf = (r) => viewPath(r)
const readState = (r) => JSON.parse(fs.readFileSync(statePathOf(r), 'utf8'))

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

/** Config propriétaire : sources explicites, jamais de chemin par défaut implicite. */
const cfg = (r, sources = {}) => ({ root: r, sources })

/** Lecture indépendante de la vue pour vérifier les comptes attendus. */
function viewCounts (r) {
  const db = new Database(viewPathOf(r), { readonly: true, fileMustExist: true })
  try {
    let rawrefs = null
    try { rawrefs = db.prepare('SELECT COUNT(*) n FROM rawrefs').get().n } catch { /* table absente tolérée */ }
    return {
      sessions: db.prepare('SELECT COUNT(*) n FROM sessions').get().n,
      events: db.prepare("SELECT COUNT(*) n FROM events WHERE role != 'title'").get().n,
      rawrefs
    }
  } finally { db.close() }
}

function expectUnavailable (fn, reason) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    assert.equal(e.name, 'McpAppError')
    assert.equal(e.code, 'view_unavailable', e.message)
    assert.equal(e.reason, reason)
    const payload = appErrorPayload(e)
    assert.equal(payload.code, 'view_unavailable')
    assert.equal(payload.reason, reason)
    assert.ok(!JSON.stringify(payload).includes(tmp))
  }
}

before(async () => {
  buildFixtureDb(dbPath)
  await ingest({ root, db: dbPath, source: 'opencode' })
  index(root)
  const uuid = fakeUuid()
  writePiSession(piDir, 'proj-a', 'ses_a.jsonl', [
    sessionLine(uuid, T0, '/root/proj-a'),
    infoLine(T0 + 10, 'Requête pi status', 'infa'),
    messageLine(T0 + 1000, { role: 'user', content: [{ type: 'text', text: 'message pi synthétique' }], timestamp: T0 + 100 }),
    messageLine(T0 + 2000, { role: 'assistant', content: [{ type: 'text', text: 'réponse pi synthétique' }], provider: 'antho', model: 'sonnet-x', timestamp: T0 + 1500 })
  ])
  await ingest({ root: rootPi, db: dbPath, piDir, source: 'all' })
  index(rootPi)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ── Statut nominal ──────────────────────────────────────────────────────────

test('status nominal : compteurs globaux/par source, view, fraîcheur, aucun chemin', () => {
  const handler = createStatusHandler(cfg(rootPi, { opencode: { path: dbPath }, pi: { path: piDir } }))
  const out = handler({}, [])
  assert.ok(statusOutputSchema.safeParse(out).success, JSON.stringify(statusOutputSchema.safeParse(out).error ?? {}))

  const expected = viewCounts(rootPi)
  assert.deepEqual(out.counts, { sessions: expected.sessions, events: expected.events })
  assert.equal(out.rawFiles, expected.rawrefs)
  assert.equal(out.view.events, out.counts.events)
  assert.ok(Number.isFinite(out.view.mtime))
  assert.equal(out.viewNote, null)

  assert.deepEqual(Object.keys(out.sources).sort(), ['opencode', 'pi'])
  assert.equal(out.sources.opencode.available, true)
  assert.equal(out.sources.opencode.ingested, true)
  assert.equal(typeof out.sources.opencode.watermark.message, 'number')
  assert.equal(out.sources.opencode.watermark.session, readState(rootPi).sources.opencode.session)
  // Fixture connue : 3 sessions opencode (5 événements hors titres) + 1 session pi (2 messages).
  assert.deepEqual(out.sources.opencode.counts, { sessions: 3, events: 5 })
  assert.equal(out.sources.pi.available, true)
  assert.equal(out.sources.pi.ingested, true)
  assert.equal(out.sources.pi.watermark.files, 1)
  assert.equal(typeof out.sources.pi.watermark.token, 'string')
  assert.deepEqual(out.sources.pi.counts, { sessions: 1, events: 2 })
  assert.equal(out.sources.opencode.counts.sessions + out.sources.pi.counts.sessions, out.counts.sessions)
  assert.equal(out.sources.opencode.counts.events + out.sources.pi.counts.events, out.counts.events)

  // Fraîcheur reprise de data.js (pas recalculée) ; aucun chemin ni nom de fichier.
  assert.equal(out.freshness.corpusVersion, 2)
  assert.ok(Number.isFinite(out.freshness.indexMtime))
  const json = JSON.stringify(out)
  assert.ok(!json.includes(rootPi))
  assert.ok(!json.includes(piDir))
  assert.ok(!json.includes('ses_a.jsonl'))
  assert.ok(!json.includes('proj-a'))
  assert.ok(!json.includes(SECRET))
})

test('status : source configurée mais non ingérée = ingested false, watermark null, comptes null', () => {
  const handler = createStatusHandler(cfg(root, { opencode: { path: dbPath }, pi: { path: piDir } }))
  const out = handler({}, [])
  assert.ok(statusOutputSchema.safeParse(out).success)
  assert.deepEqual(out.sources.pi, {
    available: true,
    ingested: false,
    watermark: null,
    counts: { sessions: null, events: null }
  })
  assert.equal(out.sources.opencode.ingested, true)
})

test('status : source absente mais archivée = disponible false, état conservé, comptes connus', () => {
  const handler = createStatusHandler(cfg(rootPi, { opencode: { path: dbPath }, pi: { path: piAbsent } }))
  const out = handler({}, [])
  assert.ok(statusOutputSchema.safeParse(out).success)
  assert.equal(out.sources.pi.available, false)
  assert.equal(out.sources.pi.ingested, true)
  assert.equal(out.sources.pi.watermark.files, 1)
  assert.deepEqual(out.sources.pi.counts, { sessions: 1, events: 2 })
})

test('status : source archivée NON configurée = disponible null (indéterminable), état conservé', () => {
  const handler = createStatusHandler(cfg(rootPi, { opencode: { path: dbPath } }))
  const out = handler({}, [])
  assert.ok(statusOutputSchema.safeParse(out).success)
  assert.deepEqual(Object.keys(out.sources).sort(), ['opencode', 'pi'])
  assert.equal(out.sources.pi.available, null, 'sans chemin configuré, la disponibilité reste inconnue')
  assert.equal(out.sources.pi.ingested, true)
  assert.deepEqual(out.sources.pi.counts, { sessions: 1, events: 2 })
})

test('status : accès non déterminable (EACCES) = available null, jamais false inventé', () => {
  const piEacces = path.join(tmp, 'pi-eacces')
  const realStat = fs.statSync
  fs.statSync = function (p, ...a) {
    if (p === piEacces) { const e = new Error('refus'); e.code = 'EACCES'; throw e }
    return realStat.call(fs, p, ...a)
  }
  try {
    const handler = createStatusHandler(cfg(rootPi, { opencode: { path: dbPath }, pi: { path: piEacces } }))
    const out = handler({}, [])
    assert.ok(statusOutputSchema.safeParse(out).success)
    assert.equal(out.sources.pi.available, null)
    assert.equal(out.sources.pi.ingested, true)
    assert.equal(out.sources.opencode.available, true)
  } finally { fs.statSync = realStat }
})

test('status : nom de source inconnu ignoré, jamais rendu', () => {
  const handler = createStatusHandler(cfg(root, { opencode: { path: dbPath }, martien: { path: path.join(tmp, 'martien') } }))
  const out = handler({}, [])
  assert.deepEqual(Object.keys(out.sources).sort(), ['opencode'])
  assert.ok(!JSON.stringify(out).includes('martien'))
})

// ── Compteurs honnêtes (vue connue / null) ──────────────────────────────────

test('status : rawFiles connu de la vue ; compteur indisponible => null sans estimation', () => {
  const nominal = createStatusHandler(cfg(root, { opencode: { path: dbPath } }))({}, [])
  assert.equal(nominal.rawFiles, viewCounts(root).rawrefs)

  const noRefs = copyRoot(root)
  const db = new Database(viewPathOf(noRefs))
  try { db.exec('DROP TABLE rawrefs') } finally { db.close() }
  const out = createStatusHandler(cfg(noRefs, { opencode: { path: dbPath } }))({}, [])
  assert.ok(statusOutputSchema.safeParse(out).success)
  assert.equal(out.rawFiles, null, 'compteur indisponible = null, jamais 0 estimé')
  assert.equal(out.counts.events, viewCounts(noRefs).events, 'compteurs globaux toujours connus')
})

test('status : comptes par source inconnus (JSON de session illisible) => null, globaux connus', () => {
  const broken = copyRoot(rootPi)
  const db = new Database(viewPathOf(broken))
  try { db.prepare("INSERT INTO sessions (id, json) VALUES ('x-corrompu', 'pas-du-json')").run() } finally { db.close() }
  const out = createStatusHandler(cfg(broken, { opencode: { path: dbPath }, pi: { path: piDir } }))({}, [])
  assert.ok(statusOutputSchema.safeParse(out).success)
  assert.ok(Number.isInteger(out.counts.sessions))
  assert.deepEqual(out.sources.opencode.counts, { sessions: null, events: null })
  assert.deepEqual(out.sources.pi.counts, { sessions: null, events: null })
})

// ── Erreurs closes : vue indisponible ───────────────────────────────────────

test('status : vue absente / périmée => view_unavailable, raison fermée, sans chemin', () => {
  const empty = path.join(tmp, 'racine-vide')
  fs.mkdirSync(empty, { recursive: true })
  expectUnavailable(() => createStatusHandler(cfg(empty, { opencode: { path: dbPath } }))({}, []), 'missing_view')

  const stale = copyRoot(root)
  const st = readState(stale)
  st.sources.opencode.message = (st.sources.opencode.message ?? 0) + 1000
  fs.writeFileSync(statePathOf(stale), JSON.stringify(st, null, 2) + '\n')
  expectUnavailable(() => createStatusHandler(cfg(stale, { opencode: { path: dbPath } }))({}, []), 'stale_view')

  const noState = copyRoot(root)
  fs.rmSync(statePathOf(noState))
  expectUnavailable(() => createStatusHandler(cfg(noState, { opencode: { path: dbPath } }))({}, []), 'missing_state')

  const badConfig = () => createStatusHandler({ root, sources: { opencode: { path: 42 } } })({}, [])
  try {
    badConfig()
    assert.fail('devait refuser')
  } catch (e) {
    assert.equal(e.code, 'internal')
    assert.equal(e.reason, 'invalid_config')
  }
})

// ── Bout-en-bout via le serveur réel (port OS éphémère) ─────────────────────

test('status via serveur MCP réel : sortie validée par le contrat, port éphémère', async () => {
  const handlers = {
    sdig_search: async () => ({}),
    sdig_read: async () => ({}),
    sdig_status: createStatusHandler(cfg(rootPi, { opencode: { path: dbPath }, pi: { path: piDir } }))
  }
  const srv = createMcpTestServer({ handlers })
  await srv.start()
  try {
    assert.notEqual(srv.address().port, 18767)
    const client = new Client({ name: 'mcp-status-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`))
    await client.connect(transport)
    try {
      const res = await client.callTool({ name: 'sdig_status', arguments: {} })
      assert.notEqual(res.isError, true)
      assert.ok(statusOutputSchema.safeParse(res.structuredContent).success)
      assert.equal(res.structuredContent.sources.pi.ingested, true)
      assert.ok(!JSON.stringify(res).includes(rootPi))
      // Un paramètre explicite (dont `cursor`) est refusé avant tout travail.
      const bad = await client.callTool({ name: 'sdig_status', arguments: { cursor: 'x' } })
      assert.equal(bad.isError, true)
      assert.equal(JSON.parse(bad.content[0].text).code, 'invalid_params')
    } finally {
      await client.close()
    }
  } finally {
    await srv.close()
  }
})
