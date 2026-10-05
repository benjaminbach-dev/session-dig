// Lot M4 : fabrique d'application (`src/mcp/app.js`) + commande `sdig mcp`.
// Fixtures 100 % synthétiques ; serveurs de test ÉPHÉMÈRES (port OS), JAMAIS 18767.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import { createApp, createSafeLogger, installAppShutdown, launchErrorMessage } from '../src/mcp/app.js'
import { createMcpTestServer } from '../src/mcp/server.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-app-'))
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi-un')
const LONG_TEXT = 'L' + 'é'.repeat(60000)
const SDIG = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
const CHILD = fileURLToPath(new URL('./helpers/mcp-app-child.js', import.meta.url))

function addMessage (db, { sesId, msgId, text, ts, title = null }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run(sesId, 'p', `/root/${sesId}`, title ?? sesId, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(msgId, sesId, ts, ts, JSON.stringify({ role: 'user', agent: 'build' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
}

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try { addMessage(db, { sesId: 'ses_long', msgId: 'msg_long', text: LONG_TEXT, ts: T0 + 900000, title: 'Long' }) } finally { db.close() }
  writePiSession(piDir, 'proj-a', 'ses_pi.jsonl', [
    sessionLine(fakeUuid(), T0, '/root/pi-un'),
    infoLine(T0 + 10, 'Titre pi', 'inf'),
    messageLine(T0 + 1000, { role: 'user', content: [{ type: 'text', text: 'pimotif unique' }], timestamp: T0 + 1000 })
  ])
  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function archiveSha (dir) {
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!/index\.db-(wal|shm)$/.test(e.name)) files.push(p)
    }
  }
  walk(dir)
  files.sort()
  const h = crypto.createHash('sha256')
  for (const f of files) { h.update(path.relative(dir, f)); h.update('\0'); h.update(fs.readFileSync(f)); h.update('\0') }
  return h.digest('hex')
}

function copyCorpus (src) {
  const dst = fs.mkdtempSync(path.join(tmp, 'copie-'))
  fs.copyFileSync(path.join(src, 'index.db'), path.join(dst, 'index.db'))
  fs.copyFileSync(path.join(src, 'state.json'), path.join(dst, 'state.json'))
  fs.cpSync(path.join(src, 'events'), path.join(dst, 'events'), { recursive: true })
  if (fs.existsSync(path.join(src, 'raw'))) fs.cpSync(path.join(src, 'raw'), path.join(dst, 'raw'), { recursive: true })
  fs.copyFileSync(path.join(src, 'sessions.jsonl'), path.join(dst, 'sessions.jsonl'))
  return dst
}

async function connect (app) {
  const client = new Client({ name: 'mcp-app-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server.address().port}/mcp`))
  await client.connect(transport)
  return client
}

/** Enfant éphémère (helper `mcp-app-child.js`) : annonce son port puis attend un signal. */
async function spawnChild (env = {}) {
  const child = spawn(process.execPath, [CHILD], {
    env: { ...process.env, ROOT: root, DB: dbPath, PI: piDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`port non annoncé — stderr: ${err}`)), 15000)
    const check = () => { const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(Number(m[1])) } }
    child.stdout.on('data', check)
    check()
  })
  return { child, port, getErr: () => err }
}

const cfg = () => ({ root, db: dbPath, piDir, serverFactory: createMcpTestServer, logger: () => {} })

// ── Fabrique : câblage ──────────────────────────────────────────────────────

test('createApp : monte EXACTEMENT les 3 handlers, token transmis, dispose fermé', () => {
  let captured = null
  const fake = (opts) => { captured = opts; return { start: async () => ({}), close: async () => {}, address: () => null } }
  const app = createApp({ root, db: dbPath, piDir, serverFactory: fake, token: 'jeton-de-test', logger: () => {} })
  assert.deepEqual(Object.keys(captured.handlers).sort(), ['sdig_read', 'sdig_search', 'sdig_status'])
  assert.equal(captured.token, 'jeton-de-test')
  assert.equal(typeof captured.dispose, 'function')
  assert.equal(typeof captured.logger, 'function')
  captured.dispose()
  assert.equal(app.read.cursors.size, 0)
})

test('journal sûr : champs ET valeurs épinglés (objet/chaîne détourné ignoré)', () => {
  const lines = []
  const log = createSafeLogger((l) => lines.push(l))
  log({ event: 'tool', tool: 'sdig_search', outcome: 'ok', durationMs: 3, query: 'SECRET-QUERY', text: 'SECRET-TEXT', path: '/secret/path', token: 'SECRET-TOKEN', cursor: 'SECRET-CURSOR' })
  log({ event: 'tool', tool: { query: 'SECRET-OBJ' }, outcome: 'ok', reason: 'SECRET-STR', durationMs: 3 })
  log({ event: 'guard', code: 'forbidden_host', status: 403 })
  log({ event: 'tool', tool: 'sdig_read', outcome: 'invalid_params', reason: 'invalid_config', durationMs: 5 })
  log({ event: 'tool', tool: 'sdig_read', outcome: 'app_error', code: 'unknown_session', reason: 'SECRET-STR', durationMs: 7 })
  log({ event: 'tool', tool: 'sdig_read', outcome: 'SECRET-OUTCOME', code: 'SECRET-CODE', durationMs: 2 })
  log(null)
  log('SECRET-RAW')
  const joined = lines.join('\n')
  for (const bad of ['SECRET-QUERY', 'SECRET-TEXT', '/secret/path', 'SECRET-TOKEN', 'SECRET-CURSOR', 'SECRET-OBJ', 'SECRET-STR', 'SECRET-RAW', 'SECRET-OUTCOME', 'SECRET-CODE']) {
    assert.ok(!joined.includes(bad), `fuite ${bad}`)
  }
  assert.deepEqual(JSON.parse(lines[0]), { event: 'tool', tool: 'sdig_search', outcome: 'ok', durationMs: 3 })
  assert.deepEqual(JSON.parse(lines[1]), { event: 'tool', outcome: 'ok', durationMs: 3 }, 'tool objet + reason inconnu ignorés')
  assert.deepEqual(JSON.parse(lines[2]), { event: 'guard', code: 'forbidden_host', status: 403 })
  assert.deepEqual(JSON.parse(lines[3]), { event: 'tool', tool: 'sdig_read', outcome: 'invalid_params', reason: 'invalid_config', durationMs: 5 })
  assert.deepEqual(JSON.parse(lines[4]), { event: 'tool', tool: 'sdig_read', outcome: 'app_error', code: 'unknown_session', durationMs: 7 }, 'outcome app_error + code fermé conservés, raison détournée ignorée')
  assert.deepEqual(JSON.parse(lines[5]), { event: 'tool', tool: 'sdig_read', durationMs: 2 }, 'outcome/code inconnus ignorés')
  assert.equal(lines.length, 6, 'entrées non conformes ignorées')
})

test('installAppShutdown : close→dispose→exit(0) ; échec ⇒ exit(1) + diagnostic FIXE', async () => {
  const events = []
  const mkApp = (failClose) => ({
    server: { close: async () => { events.push('close'); if (failClose) throw new Error('SECRET-STACK') } },
    read: { dispose: () => events.push('dispose') }
  })
  let code = null
  const h1 = installAppShutdown(mkApp(false), { exit: (c) => { code = c }, onError: () => {}, signals: [] })
  await h1.stop()
  assert.deepEqual(events, ['close', 'dispose'], 'close TERMINÉ avant dispose')
  assert.equal(code, 0)

  events.length = 0
  const errs = []
  const h2 = installAppShutdown(mkApp(true), { exit: (c) => { code = c }, onError: (m) => errs.push(m), signals: [] })
  await h2.stop()
  await h2.stop() // idempotent : pas de double cleanup
  assert.deepEqual(events, ['close', 'dispose'])
  assert.equal(code, 1, 'échec de fermeture ⇒ exit 1')
  assert.equal(errs.length, 1)
  assert.match(errs[0], /arrêt en échec \(fermeture\/dispose\)/)
  assert.ok(!errs[0].includes('SECRET-STACK'))
})

test('launchErrorMessage : errno d’écoute PINNÉ, sinon générique (jamais de code arbitraire)', () => {
  assert.equal(launchErrorMessage({ code: 'EADDRINUSE' }), 'mcp : démarrage refusé (EADDRINUSE)')
  assert.equal(launchErrorMessage({ code: 'EACCES' }), 'mcp : démarrage refusé (EACCES)')
  assert.equal(launchErrorMessage({ code: 'ESKSECRETVALUE' }), 'mcp : démarrage refusé', 'code arbitraire NON recopié')
  assert.equal(launchErrorMessage(new Error('boom /secret/path')), 'mcp : démarrage refusé')
})

// ── E2E client officiel sur la fabrique réelle (serveur éphémère) ───────────

test('E2E : 3 handlers, search → read paginé long → status, reconnexion, source, archive SHA', async () => {
  const before = archiveSha(root)
  const app = createApp(cfg())
  await app.server.start()
  const t0 = Date.now()
  try {
    assert.notEqual(app.server.address().port, 18767, 'jamais le port de production')
    const c1 = await connect(app)
    const tools = await c1.listTools()
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['sdig_read', 'sdig_search', 'sdig_status'])

    const s = await c1.callTool({ name: 'sdig_search', arguments: { query: 'proxy' } })
    assert.notEqual(s.isError, true)
    assert.ok(s.structuredContent.hits.length >= 1)
    assert.ok(s.structuredContent.hits[0].ref.sessionId)

    // read paginé du message long : recollement EXACT par fragments.
    let cursor = null
    let text = ''
    let pages = 0
    for (;;) {
      const r = await c1.callTool({ name: 'sdig_read', arguments: cursor ? { cursor } : { session: 'ses_long', full: true } })
      assert.notEqual(r.isError, true)
      for (const m of r.structuredContent.messages) text += m.text
      pages++
      if (!r.structuredContent.truncated || !r.structuredContent.truncated.nextCursor) break
      cursor = r.structuredContent.truncated.nextCursor
      if (pages > 10) assert.fail('trop de pages')
    }
    assert.equal(text, LONG_TEXT)

    const st = await c1.callTool({ name: 'sdig_status', arguments: {} })
    assert.notEqual(st.isError, true)
    assert.equal(st.structuredContent.rawFiles, null, 'compteur physique inconnu ⇒ null')
    assert.ok(Number.isInteger(st.structuredContent.rawReferences))
    await c1.close()

    // reconnexion stateless + filtre source.
    const c2 = await connect(app)
    const p = await c2.callTool({ name: 'sdig_search', arguments: { query: 'pimotif', source: 'pi' } })
    assert.notEqual(p.isError, true)
    assert.ok(p.structuredContent.hits.length >= 1)
    assert.ok(p.structuredContent.hits.every((h) => h.source === 'pi'))
    await c2.close()

    // Diagnostic de durée borné (non privé) : jamais un banc.
    const perf = Date.now() - t0
    assert.ok(perf < 60000, `durée E2E ${perf} ms`)
  } finally {
    await app.server.close()
  }
  assert.equal(archiveSha(root), before, 'archive bitwise inchangée (annexes WAL exclues)')
})

test('arrêt/redémarrage : cache de curseurs purgé (curseur étranger refusé)', async () => {
  const app1 = createApp(cfg())
  await app1.server.start()
  const c1 = await connect(app1)
  const p1 = await c1.callTool({ name: 'sdig_read', arguments: { session: 'ses_long', full: true } })
  const cursor = p1.structuredContent.truncated.nextCursor
  assert.ok(cursor)
  await c1.close()
  await app1.server.close() // dispose → purge du cache
  assert.equal(app1.read.cursors.size, 0)

  const app2 = createApp(cfg())
  await app2.server.start()
  try {
    const c2 = await connect(app2)
    const bad = await c2.callTool({ name: 'sdig_read', arguments: { cursor } })
    assert.equal(bad.isError, true)
    assert.equal(JSON.parse(bad.content[0].text).code, 'invalid_cursor')
    await c2.close()
  } finally { await app2.server.close() }
})

test('génération changée pendant la suite ⇒ stale_cursor', async () => {
  const r = copyCorpus(root)
  const app = createApp({ root: r, db: dbPath, piDir, serverFactory: createMcpTestServer, logger: () => {} })
  await app.server.start()
  try {
    const c = await connect(app)
    const p1 = await c.callTool({ name: 'sdig_read', arguments: { session: 'ses_long', full: true } })
    const cursor = p1.structuredContent.truncated.nextCursor
    assert.ok(cursor)
    index(r) // rebuild : génération renouvelée (mêmes corpus/watermarks)
    const bad = await c.callTool({ name: 'sdig_read', arguments: { cursor } })
    assert.equal(bad.isError, true)
    assert.equal(JSON.parse(bad.content[0].text).code, 'stale_cursor')
    await c.close()
  } finally { await app.server.close() }
})

// ── Arrêt par signal (enfant éphémère, jamais le port de production) ────────

test('SIGTERM/SIGINT : arrêt propre de la fabrique (close + dispose), port éphémère', async () => {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const { child, port } = await spawnChild()
    assert.notEqual(port, 18767, 'jamais le port de production')
    child.kill(sig)
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)))
    assert.equal(code, 0, `${sig} : arrêt propre attendu`)
  }
})

test('échec de fermeture : code 1 + diagnostic FIXE, sans donnée', async () => {
  const { child, port, getErr } = await spawnChild({ FAIL_CLOSE: '1' })
  assert.notEqual(port, 18767)
  child.kill('SIGTERM')
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)))
  assert.equal(code, 1, 'échec de fermeture ⇒ code 1, jamais un faux succès')
  assert.match(getErr(), /arrêt en échec \(fermeture\/dispose\)/)
})

// ── CLI : --help / arguments invalides sans écho ni binding ─────────────────

function runCli (args) {
  try {
    const stdout = execFileSync(process.execPath, [SDIG, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out: stdout, err: '' }
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }
  }
}

test('CLI sdig mcp : --help, options/positionnels/valeurs invalides refusés SANS écho', () => {
  const help = runCli(['mcp', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.out, /127\.0\.0\.1:18767/)

  const SENT = 'sk-SENTINEL-DO-NOT-LEAK-42'
  const cases = [
    ['mcp', `--token=${SENT}`],
    ['mcp', '--bogus', SENT],
    ['mcp', SENT],
    ['mcp', '--json'],
    ['mcp', '--home'], // valeur absente
    ['mcp', '--home', '--port'], // la valeur est l'option suivante
    ['mcp', '--db', '--pi-dir'],
    ['mcp', '--pi-dir', ''], // valeur vide
    ['mcp', '--home', '--SENTVALUE']
  ]
  for (const args of cases) {
    const r = runCli(args)
    assert.notEqual(r.code, 0, `doit refuser ${JSON.stringify(args)}`)
    assert.ok(!r.out.includes(SENT) && !r.err.includes(SENT), `aucune fuite pour ${JSON.stringify(args)} : ${r.err}`)
    assert.ok(!r.err.includes('--SENTVALUE'), 'la valeur refusée n’est pas recopiée')
    assert.ok(!r.err.includes('écoute'), 'aucun démarrage (pas de binding 18767)')
    assert.match(r.err, /mcp : (option non reconnue|aucun argument positionnel admis|valeur manquante ou invalide)/, JSON.stringify(args))
  }
})
