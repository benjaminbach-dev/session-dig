// Serveur MCP Streamable HTTP (lot M1b) — tests sur fixtures/stubs SYNTHÉTIQUES,
// réseau local temporaire (port OS éphémère sur 127.0.0.1). Aucun service
// persistant, aucun corpus réel, aucun handler métier livré (stubs locaux).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createMcpServer,
  createMcpTestServer,
  RESPONSE_BUDGET_BYTES,
  MAX_BODY_BYTES,
  APP_ERROR_MESSAGES,
  checkBearer,
  constantTimeEqual,
  parseHostHeader,
  isLoopbackOrigin,
  isValidRequestId,
  sanitizeProtocolError
} from '../src/mcp/index.js'

const PROTO = '2025-11-25'
const SECRET = 'sk-live-SUPER-SECRET-42'
const freshness = { sources: {}, indexMtime: 123.456, corpusVersion: 2 }
const searchOutput = (extra = {}) => ({ hits: [], neighbors: [], groups: [], count: 0, topK: 10, total: null, adaptations: [], freshness, ...extra })
const readOutput = () => ({ sessionId: 's', title: null, repo: null, anchor: null, maskedCount: 0, visible: 0, total: 0, messages: [], adaptations: [], freshness })
const statusOutput = () => ({ counts: { sessions: 0, events: 0 }, rawFiles: 0, view: null, viewNote: null, sources: {}, freshness })
const okHandlers = () => ({ sdig_search: async () => searchOutput(), sdig_read: async () => readOutput(), sdig_status: async () => statusOutput() })

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('waitFor : condition non satisfaite')
}

function rawRequest ({ port, method = 'POST', path: p = '/mcp', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { host: `127.0.0.1:${port}`, accept: 'application/json, text/event-stream', ...headers }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: finalHeaders, setHost: false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

/** Requête HTTP brute (sockets) : permet d'envoyer des en-têtes dupliqués. */
function rawSocket ({ port, headers = [], body = '', keepOpen = false }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      const lines = ['POST /mcp HTTP/1.1', ...headers, 'connection: close', `content-length: ${Buffer.byteLength(body)}`, '', body]
      socket.write(lines.join('\r\n'))
    })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (d) => { data += d })
    socket.on('end', () => resolve({ text: data, socket }))
    socket.on('error', () => resolve({ text: data, socket }))
    if (keepOpen) resolve({ text: '', socket })
  })
}

const initializeBody = () => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 't', version: '0' } } })

async function withServer (handlers, fn, opts = {}) {
  const srv = createMcpTestServer({ handlers, ...opts })
  await srv.start()
  try {
    return await fn(srv)
  } finally {
    await srv.close()
  }
}

async function connectClient (srv, requestInit) {
  const client = new Client({ name: 'mcp-server-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`), requestInit ? { requestInit } : undefined)
  await client.connect(transport)
  return client
}

// ── Configuration ───────────────────────────────────────────────────────────

test('production : configuration refusée SANS démarrer le port 18767', () => {
  assert.throws(() => createMcpServer({ handlers: okHandlers(), host: '0.0.0.0' }), /loopback/)
  assert.throws(() => createMcpServer({ handlers: okHandlers(), port: 8080 }), /port/)
  const srv = createMcpServer({ handlers: okHandlers(), host: null, port: null })
  assert.equal(srv.address(), null, 'aucune écoute avant start()')
  assert.ok(srv.httpServer)
})

test('primitive de test : port OS éphémère, toujours 127.0.0.1', async () => {
  await withServer(okHandlers(), async (srv) => {
    const a = srv.address()
    assert.equal(a.host, '127.0.0.1')
    assert.ok(a.port > 0 && a.port !== 18767)
  })
})

test('handlers métier requis : exactement les trois fonctions', () => {
  assert.throws(() => createMcpTestServer({}), /handlers/)
  assert.throws(() => createMcpTestServer({ handlers: { sdig_search: async () => ({}) } }), /handlers/)
  assert.throws(() => createMcpTestServer({ handlers: { ...okHandlers(), sdig_raw: async () => ({}) } }), /handlers/)
  assert.ok(createMcpTestServer({ handlers: okHandlers() }).httpServer)
})

test('handlers : propriétés PROPRES uniquement (héritage et clé parasite refusés)', () => {
  const inherited = Object.create({ sdig_status: async () => statusOutput() })
  inherited.sdig_search = async () => searchOutput()
  inherited.sdig_read = async () => readOutput()
  assert.throws(() => createMcpTestServer({ handlers: inherited }), /handlers/)
  const withJunk = { ...okHandlers(), junk: async () => ({}) }
  assert.throws(() => createMcpTestServer({ handlers: withJunk }), /handlers/)
})

test('jeton : configuration invalide refusée au constructeur (aucune conversion)', () => {
  for (const bad of ['', '   ', 'a b', 'jeton\n', 42, {}, [], 'x'.repeat(5000)]) {
    assert.throws(() => createMcpTestServer({ handlers: okHandlers(), token: bad }), /token/, JSON.stringify(bad).slice(0, 20))
  }
  assert.ok(createMcpTestServer({ handlers: okHandlers(), token: null }).httpServer)
  assert.ok(createMcpTestServer({ handlers: okHandlers(), token: 'jeton-ok' }).httpServer)
})

test('logger/dispose : fonction exigée si fournis', () => {
  assert.throws(() => createMcpTestServer({ handlers: okHandlers(), logger: {} }), /logger/)
  assert.throws(() => createMcpTestServer({ handlers: okHandlers(), dispose: 1 }), /dispose/)
})

// ── Client officiel réel ────────────────────────────────────────────────────

test('client Streamable HTTP réel : initialize/list/call puis reconnexion stateless', async () => {
  await withServer(okHandlers(), async (srv) => {
    const c1 = await connectClient(srv)
    try {
      const tools = await c1.listTools()
      assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['sdig_read', 'sdig_search', 'sdig_status'])
      for (const t of tools.tools) assert.equal(t.inputSchema.additionalProperties, false)
      const r = await c1.callTool({ name: 'sdig_search', arguments: { query: 'bug proxy' } })
      assert.notEqual(r.isError, true)
      assert.equal(r.structuredContent.count, 0)
    } finally { await c1.close() }
    const c2 = await connectClient(srv)
    try {
      const st = await c2.callTool({ name: 'sdig_status', arguments: {} })
      assert.notEqual(st.isError, true)
    } finally { await c2.close() }
  })
})

test('catalogue fermé, route FIXE /mcp, aucun raw/resource/prompt', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const h = { 'content-type': 'application/json', 'mcp-protocol-version': PROTO }
    for (const method of ['resources/list', 'prompts/list']) {
      const r = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method }) })
      assert.match(r.text, /Method not found/)
    }
    const otherPath = await rawRequest({ port, path: '/autre', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 't', version: '0' } } }) })
    assert.equal(otherPath.status, 404)
    const withQuery = await rawRequest({ port, path: '/mcp?x=1', headers: h, body: initializeBody() })
    assert.equal(withQuery.status, 404)
  })
})

// ── Validation avant handler ────────────────────────────────────────────────

test('entrées invalides : invalid_params applicatif AVANT le handler métier', async () => {
  const calls = []
  const handlers = {
    sdig_search: async (value) => { calls.push(['search', value]); return searchOutput() },
    sdig_read: async () => { calls.push(['read']); return readOutput() },
    sdig_status: async () => { calls.push(['status']); return statusOutput() }
  }
  await withServer(handlers, async (srv) => {
    const client = await connectClient(srv)
    try {
      const cases = [
        { name: 'sdig_search', arguments: { query: 'ok', cursor: 'x' }, code: 'invalid_params' },
        { name: 'sdig_search', arguments: { query: '+++ ---' }, code: 'invalid_params' },
        { name: 'sdig_search', arguments: { query: 'ok', limit: 0 }, code: 'invalid_params' },
        { name: 'sdig_read', arguments: {}, code: 'invalid_params' },
        { name: 'sdig_read', arguments: { session: 's', at: '' }, code: 'invalid_anchor' }
      ]
      for (const c of cases) {
        const r = await client.callTool({ name: c.name, arguments: c.arguments })
        assert.equal(r.isError, true, `${c.name} ${JSON.stringify(c.arguments)}`)
        assert.equal(JSON.parse(r.content[0].text).code, c.code)
      }
      assert.deepEqual(calls, [], 'aucun handler métier appelé sur entrée invalide')
      const ok = await client.callTool({ name: 'sdig_search', arguments: { query: 'ok', limit: 999 } })
      assert.notEqual(ok.isError, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0][1].limit, 50)
    } finally { await client.close() }
  })
})

// ── Sans écho : version, params, identifiants, JSON ─────────────────────────

test('entête mcp-protocol-version inconnue : erreur bornée sans écho', async () => {
  await withServer(okHandlers(), async (srv) => {
    const r = await rawRequest({
      port: srv.address().port,
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': SECRET },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    assert.ok(r.status >= 400)
    assert.ok(!r.text.includes(SECRET))
    assert.ok(r.text.length < 200)
    const init = await rawRequest({ port: srv.address().port, headers: { 'content-type': 'application/json', 'mcp-protocol-version': SECRET }, body: initializeBody() })
    assert.equal(init.status, 200, 'initialize n’exige pas l’en-tête')
  })
})

test('en-têtes au-delà du plafond : refusés sans écho', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const huge = await rawSocket({ port, headers: ['host: 127.0.0.1:' + port, 'x-secret: ' + SECRET.repeat(2000), 'content-type: application/json'], body: initializeBody() })
    const firstLine = huge.text.split('\r\n')[0]
    assert.ok(huge.text === '' || / 431 /.test(firstLine), firstLine)
    assert.ok(!huge.text.includes(SECRET))
  })
})

test('paramètres protocolaires connus malformés : -32602 générique sans écho', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const h = { 'content-type': 'application/json', 'mcp-protocol-version': PROTO }
    const badInit = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 123, capabilities: {}, clientInfo: { name: 'x', version: 1, secret: SECRET } } }) })
    assert.match(badInit.text, /Invalid params/)
    assert.ok(!badInit.text.includes(SECRET))
    const badCallName = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 123, arguments: { [SECRET]: SECRET } } }) })
    assert.match(badCallName.text, /Invalid params/)
    assert.ok(!badCallName.text.includes(SECRET))
    const badArgs = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sdig_search', arguments: SECRET } }) })
    assert.match(badArgs.text, /Invalid params/)
    assert.ok(!badArgs.text.includes(SECRET))
    const badList = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: 42, secret: SECRET } }) })
    assert.match(badList.text, /Invalid params/)
    assert.ok(!badList.text.includes(SECRET))
  })
})

test('identifiants JSON-RPC : bornés, sinon invalid request id:null sans copie', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const h = { 'content-type': 'application/json', 'mcp-protocol-version': PROTO }
    const longId = 'A'.repeat(200000)
    const r = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: longId, method: 'no/such' }) })
    assert.ok(r.text.length < 200)
    assert.ok(!r.text.includes(longId))
    assert.deepEqual(JSON.parse(r.text).id, null)
    assert.match(r.text, /Invalid Request/)
    for (const id of [null, 1.5, -3, { a: 1 }, [1], 'id avec espace', SECRET + ' x']) {
      const rr = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'no/such' }) })
      const parsed = JSON.parse(rr.text)
      assert.equal(parsed.id, null, `id refusé : ${JSON.stringify(id).slice(0, 20)}`)
      assert.ok(!rr.text.includes(SECRET))
    }
    const validString = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 'abc-1.2_3', method: 'no/such' }) })
    assert.equal(JSON.parse(validString.text).id, 'abc-1.2_3')
    const validNumber = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'no/such' }) })
    assert.equal(JSON.parse(validNumber.text).id, 0)
  })
})

test('JSON/JSON-RPC invalides : réponses protocolaires bornées sans écho', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const h = { 'content-type': 'application/json' }
    assert.match((await rawRequest({ port, headers: h, body: '{"jsonrpc":"2.0",' })).text, /Parse error/)
    assert.match((await rawRequest({ port, headers: h, body: '[]' })).text, /Invalid Request/)
    assert.match((await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '1.0', method: 'x' }) })).text, /Invalid Request/)
    const unknownTool = await rawRequest({ port, headers: { ...h, 'mcp-protocol-version': PROTO }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: SECRET, arguments: {} } }) })
    assert.ok(!unknownTool.text.includes(SECRET))
    const unknownMethod = await rawRequest({ port, headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: SECRET }) })
    assert.match(unknownMethod.text, /Method not found/)
    assert.ok(!unknownMethod.text.includes(SECRET))
  })
})

test('corps borné avant analyse : 600 k octets refusés sans écho', async () => {
  await withServer(okHandlers(), async (srv) => {
    const r = await rawRequest({ port: srv.address().port, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sdig_search', arguments: { query: SECRET.repeat(20000) } } }) })
    assert.equal(r.status, 413)
    assert.ok(!r.text.includes(SECRET))
    assert.ok(MAX_BODY_BYTES < 600000)
  })
})

// ── Garde-fous Host/Origin/jeton ────────────────────────────────────────────

test('Host : formes loopback exactes, port sans zéro de tête', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const body = initializeBody()
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal((await rawRequest({ port, headers: { 'content-type': 'application/json', host }, body })).status, 200, host)
    }
    const bad = [`127.0.0.1:${port + 1}`, `evil.com:${port}`, `127.0.0.1:${port}.evil`, `user@127.0.0.1:${port}`, `127.0.0.1:${port}/path`, `127.0.0.1.:${port}`, '127.0.0.1', `127.0.0.1:0${port}`]
    for (const host of bad) {
      const r = await rawRequest({ port, headers: { 'content-type': 'application/json', host }, body })
      assert.equal(r.status, 403, `host refusé : ${host}`)
      assert.match(r.text, /forbidden_host/)
    }
  })
})

test('Origin : syntaxe BRUTE (pas de normalisation d’URL)', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const body = initializeBody()
    assert.equal((await rawRequest({ port, headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body })).status, 200)
    assert.equal((await rawRequest({ port, headers: { 'content-type': 'application/json', origin: `https://[::1]:${port}` }, body })).status, 200)
    assert.equal((await rawRequest({ port, headers: { 'content-type': 'application/json' }, body })).status, 200)
    const bad = [
      'http://localhost/a/..', 'http://localhost\\', 'http://127.1', 'http://0x7f000001',
      `http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}/%2e%2e`, `http://127.0.0.1:${port}?q=1`,
      'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:018767',
      'null', `http://user:pass@127.0.0.1:${port}`, `http://127.0.0.1:${port}, http://evil.com`
    ]
    for (const origin of bad) {
      const r = await rawRequest({ port, headers: { 'content-type': 'application/json', origin }, body })
      assert.equal(r.status, 403, `origin refusé : ${origin}`)
    }
  })
})

test('en-têtes dupliqués (Host/Origin/Authorization) refusés', async () => {
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const body = initializeBody()
    const dupHost = await rawSocket({ port, headers: ['host: 127.0.0.1:' + port, 'host: evil.com', 'content-type: application/json', 'accept: application/json, text/event-stream'], body })
    assert.ok(dupHost.text === '' || / (400|403) /.test(dupHost.text.split('\r\n')[0]), dupHost.text.slice(0, 60))
    const dupOrigin = await rawSocket({ port, headers: ['host: 127.0.0.1:' + port, 'origin: http://127.0.0.1:' + port, 'origin: http://evil.com', 'content-type: application/json', 'accept: application/json, text/event-stream'], body })
    assert.match(dupOrigin.text.split('\r\n')[0], / (403|400) /)
    const dupAuth = await rawSocket({ port, headers: ['host: 127.0.0.1:' + port, 'authorization: Bearer a', 'authorization: Bearer b', 'content-type: application/json', 'accept: application/json, text/event-stream'], body })
    assert.match(dupAuth.text.split('\r\n')[0], / (401|400) /)
  }, { token: 'a' })
})

test('jeton Bearer strict sur chaque requête, jamais dans la réponse', async () => {
  const token = 'jeton-de-test-123'
  const logs = []
  await withServer(okHandlers(), async (srv) => {
    const port = srv.address().port
    const body = initializeBody()
    const cases = [
      [{}, 401],
      [{ authorization: 'Bearer mauvais' }, 401],
      [{ authorization: 'Basic abc' }, 401],
      [{ authorization: `Bearer  ${token}` }, 401],
      [{ authorization: `Bearer ${token}` }, 200]
    ]
    for (const [headers, expected] of cases) {
      const r = await rawRequest({ port, headers: { 'content-type': 'application/json', ...headers }, body })
      assert.equal(r.status, expected)
      assert.ok(!r.text.includes(token))
    }
    assert.equal((await rawRequest({ port, method: 'GET', path: '/mcp' })).status, 401)
    assert.equal((await rawRequest({ port, method: 'GET', path: '/mcp', headers: { authorization: `Bearer ${token}` } })).status, 405)
    assert.ok(!JSON.stringify(logs).includes(token))
  }, { token, logger: (e) => logs.push(e) })
  assert.equal(checkBearer(`Bearer ${token}`, token), true)
  assert.equal(checkBearer(`bearer ${token}`, token), false)
  assert.equal(constantTimeEqual(token, token), true)
  assert.equal(constantTimeEqual(token, `${token}x`), false)
})

// ── Sorties, budget, mono-travail, arrêt ────────────────────────────────────

test('sortie non conforme au schéma => erreur internal bornée', async () => {
  const handlers = { sdig_search: async () => ({ pas: 'conforme' }), sdig_read: async () => readOutput(), sdig_status: async () => statusOutput() }
  await withServer(handlers, async (srv) => {
    const client = await connectClient(srv)
    try {
      await client.listTools()
      const r = await client.callTool({ name: 'sdig_search', arguments: { query: 'ok' } })
      assert.equal(r.isError, true)
      assert.equal(JSON.parse(r.content[0].text).code, 'internal')
      assert.equal(r.structuredContent, undefined)
    } finally { await client.close() }
  })
})

test('budget d’enveloppe : medium (champ additif) sous 524288, content:[] ; huge => internal', async () => {
  const handlers = {
    sdig_search: async (value) => searchOutput({ extraPayload: 'x'.repeat(value.query === 'medium' ? 300000 : 600000) }),
    sdig_read: async () => readOutput(),
    sdig_status: async () => statusOutput()
  }
  await withServer(handlers, async (srv) => {
    // Voie HTTP brute : mesure de l'ENVELOPPE finale réelle.
    const mediumRaw = await rawRequest({ port: srv.address().port, headers: { 'content-type': 'application/json', 'mcp-protocol-version': PROTO }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sdig_search', arguments: { query: 'medium' } } }) })
    assert.equal(mediumRaw.status, 200)
    assert.ok(Buffer.byteLength(mediumRaw.text) <= RESPONSE_BUDGET_BYTES)
    const parsed = JSON.parse(mediumRaw.text)
    assert.ok(Array.isArray(parsed.result.content) && parsed.result.content.length === 0)
    assert.ok(parsed.result.structuredContent)
    // Client officiel avec schémas de sortie en cache.
    const client = await connectClient(srv)
    try {
      await client.listTools()
      const medium = await client.callTool({ name: 'sdig_search', arguments: { query: 'medium' } })
      assert.notEqual(medium.isError, true)
      assert.equal(medium.content.length, 0)
      const huge = await client.callTool({ name: 'sdig_search', arguments: { query: 'huge' } })
      assert.equal(huge.isError, true)
      assert.equal(JSON.parse(huge.content[0].text).code, 'internal')
    } finally { await client.close() }
  })
})

test('admission mono-travail server-global : busy sans file, puis succès', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let first = true
  const handlers = {
    sdig_search: async () => { if (first) { first = false; return pending } return searchOutput() },
    sdig_read: async () => readOutput(),
    sdig_status: async () => statusOutput()
  }
  await withServer(handlers, async (srv) => {
    const a = await connectClient(srv)
    const b = await connectClient(srv)
    try {
      const callA = a.callTool({ name: 'sdig_search', arguments: { query: 'ok' } })
      await waitFor(() => srv.active)
      const busy = await b.callTool({ name: 'sdig_status', arguments: {} })
      assert.equal(busy.isError, true)
      assert.equal(JSON.parse(busy.content[0].text).code, 'busy')
      release(searchOutput())
      const done = await callA
      assert.notEqual(done.isError, true)
      await waitFor(() => !srv.active)
    } finally {
      release?.(searchOutput())
      await a.close(); await b.close()
    }
  })
})

test('déconnexion client : le créneau reste tenu jusqu’à la fin du handler', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const handlers = { sdig_search: () => pending, sdig_read: async () => readOutput(), sdig_status: async () => statusOutput() }
  const srv = createMcpTestServer({ handlers })
  await srv.start()
  try {
    const port = srv.address().port
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTO, host: `127.0.0.1:${port}` }, setHost: false })
    req.on('error', () => {})
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sdig_search', arguments: { query: 'ok' } } }))
    await waitFor(() => srv.active)
    req.destroy()
    await delay(50)
    assert.equal(srv.active, true, 'slot conservé malgré la déconnexion')
    release(searchOutput())
    await waitFor(() => !srv.active)
  } finally {
    release?.(searchOutput())
    await srv.close()
  }
})

test('arrêt normal : attend le handler actif, termine la réponse, puis dispose', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let disposed = 0
  const handlers = { sdig_search: () => pending, sdig_read: async () => readOutput(), sdig_status: async () => statusOutput() }
  const srv = createMcpTestServer({ handlers, dispose: async () => { disposed++ } })
  await srv.start()
  const port = srv.address().port
  let responseSeen = false
  const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTO, host: `127.0.0.1:${port}` }, setHost: false }, (res) => { res.on('data', () => {}); res.on('end', () => { responseSeen = true }) })
  req.on('error', () => {})
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sdig_search', arguments: { query: 'ok' } } }))
  await waitFor(() => srv.active)
  let closed = false
  const closing = srv.close().then(() => { closed = true })
  await delay(50)
  assert.equal(closed, false, 'close attend le travail actif')
  assert.equal(disposed, 0)
  release(searchOutput())
  await closing
  assert.equal(disposed, 1)
  assert.equal(responseSeen, true, 'la réponse active a été terminée avant dispose')
})

test('close : avant start, start après close refusé, start concurrent, dispose en échec', async () => {
  const s1 = createMcpTestServer({ handlers: okHandlers(), dispose: async () => {} })
  await s1.close()
  await assert.rejects(s1.start(), /arrêté/)
  await s1.close() // idempotent

  const s2 = createMcpTestServer({ handlers: okHandlers() })
  const started = s2.start()
  const closed = s2.close()
  await Promise.allSettled([started, closed])
  await assert.rejects(s2.start(), /arrêté/)

  const s3 = createMcpTestServer({ handlers: okHandlers(), dispose: async () => { throw new Error('échec dispose') } })
  await s3.start()
  await assert.rejects(s3.close(), /dispose/)
  await assert.rejects(s3.close(), /dispose/) // même promesse, idempotent
})

test('corps incomplet annulé au close (pas d’attente indéfinie)', async () => {
  const srv = createMcpTestServer({ handlers: okHandlers() })
  await srv.start()
  const port = srv.address().port
  const socket = net.connect({ host: '127.0.0.1', port }, () => {
    socket.write(`POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: 1000\r\n\r\n{"jsonrpc":"2.0"`)
  })
  socket.on('error', () => {})
  await delay(50)
  await srv.close()
  socket.destroy()
  assert.equal(srv.active, false)
})

// ── Unitaires garde-fous ────────────────────────────────────────────────────

test('parseHostHeader/isLoopbackOrigin/isValidRequestId/sanitizeProtocolError', () => {
  assert.equal(parseHostHeader('127.0.0.1:18767', 18767), true)
  assert.equal(parseHostHeader('localhost:18767', 18767), true)
  assert.equal(parseHostHeader('[::1]:18767', 18767), true)
  assert.equal(parseHostHeader('127.0.0.1:018767', 18767), false)
  assert.equal(parseHostHeader('127.0.0.1', 18767), false)
  assert.equal(isLoopbackOrigin('http://127.0.0.1:1234'), true)
  assert.equal(isLoopbackOrigin('https://[::1]:1234'), true)
  assert.equal(isLoopbackOrigin('http://localhost/a/..'), false)
  assert.equal(isLoopbackOrigin('http://127.1'), false)
  assert.equal(isLoopbackOrigin('http://127.0.0.1:1234/'), false)
  assert.equal(isValidRequestId(0), true)
  assert.equal(isValidRequestId('abc-1.2_3'), true)
  assert.equal(isValidRequestId(null), false)
  assert.equal(isValidRequestId(1.5), false)
  assert.equal(isValidRequestId('x'.repeat(200)), false)
  assert.deepEqual(sanitizeProtocolError({ jsonrpc: '2.0', id: 'x'.repeat(300), error: { code: -32000, message: 'secret ' + SECRET, data: SECRET } }), { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Server error' } })
  assert.equal(APP_ERROR_MESSAGES.busy, 'service occupé')
})