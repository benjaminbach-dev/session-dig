// Serveur MCP Streamable HTTP (lot M1b).
//
// Fabrique un serveur RÉEL sur le transport officiel, avec handlers MÉTIER
// INJECTÉS ET REQUIS (exactement `sdig_search`, `sdig_read`, `sdig_status`) :
// aucun repli factice. Le module n'ouvre ni corpus, ni index, ni base ; il ne
// fait aucun appel réseau sortant et n'installe aucun signal global.
//
// Sécurité : garde-fous Host/Origin/jeton AVANT tout travail, identifiants et
// paramètres protocolaires validés, réponses d'erreur SDK SANITISÉES (code/message
// fermés, aucun `data`), validation d'entrée par les validateurs M1a (`invalid_params`
// applicatif avant le handler), sortie validée par les schémas M1a, budget
// d'enveloppe JSON-RPC respecté. Admission mono-travail server-global et arrêt
// normal qui attend le travail actif sans couper une réponse en cours.
//
// Le serveur SDK est le `Server` bas niveau : la validation Zod du SDK n'est
// jamais empruntée pour les params connus ; `tools/list` réutilise les helpers
// JSON Schema EXPORTÉS par le paquet épinglé.
import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { TOOL_DEFINITIONS, TOOL_NAMES, searchOutputSchema, readOutputSchema, statusOutputSchema } from './schemas.js'
import { validateSearchInput, validateReadInput, validateStatusInput } from './validate.js'
import { McpAppError, isMcpAppError, toToolErrorResult } from './errors.js'
import { measureSerialized } from './budget.js'
import { AdmissionGate } from './admission.js'
import {
  checkRequest,
  readJsonBody,
  classifyRequest,
  sanitizeProtocolError,
  isSupportedProtocolVersion,
  headerValues,
  sendJson,
  sendJsonRpcError,
  sendGuardError
} from './guards.js'
import {
  MCP_HOST,
  MCP_PORT,
  MCP_ROUTE,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  MAX_TOKEN_CHARS,
  RESPONSE_BUDGET_BYTES
} from './constants.js'

const VALIDATORS = Object.freeze({
  sdig_search: validateSearchInput,
  sdig_read: validateReadInput,
  sdig_status: validateStatusInput
})
const OUTPUTS = Object.freeze({
  sdig_search: searchOutputSchema,
  sdig_read: readOutputSchema,
  sdig_status: statusOutputSchema
})

const TOOL_LIST = Object.freeze(TOOL_DEFINITIONS.map((def) => Object.freeze({
  name: def.name,
  description: def.description,
  inputSchema: toJsonSchemaCompat(normalizeObjectSchema(def.inputSchema), { strictUnions: true, pipeStrategy: 'input' }),
  outputSchema: toJsonSchemaCompat(normalizeObjectSchema(def.outputSchema), { strictUnions: true, pipeStrategy: 'output' }),
  annotations: def.annotations
})))

/** Handlers requis : exactement les trois outils en PROPRIÉTÉS PROPRES, fonctions. */
export function validateHandlers (handlers) {
  if (!handlers || typeof handlers !== 'object') {
    throw new Error('handlers métier requis : { sdig_search, sdig_read, sdig_status }')
  }
  const ownKeys = Object.keys(handlers)
  const ok = ownKeys.length === TOOL_NAMES.length &&
    TOOL_NAMES.every((name) => Object.hasOwn(handlers, name) && typeof handlers[name] === 'function') &&
    ownKeys.every((name) => TOOL_NAMES.includes(name))
  if (!ok) throw new Error('handlers métier requis : exactement sdig_search, sdig_read et sdig_status (fonctions propres)')
  return Object.freeze({ sdig_search: handlers.sdig_search, sdig_read: handlers.sdig_read, sdig_status: handlers.sdig_status })
}

/** Jeton : absent/null = désactivé ; toute autre valeur invalide refuse le démarrage. */
export function resolveToken (token) {
  if (token == null) return null
  if (typeof token !== 'string') throw new Error('token invalide : chaîne non vide requise')
  if (token.length === 0 || token.trim() !== token) throw new Error('token invalide : chaîne non vide requise')
  if (token.length > MAX_TOKEN_CHARS) throw new Error('token invalide : longueur maximale dépassée')
  if (!/^[\x21-\x7E]+$/.test(token)) throw new Error('token invalide : caractères non admissibles dans un en-tête Bearer')
  return token
}

function resolveFunction (value, name) {
  if (value == null) return null
  if (typeof value !== 'function') throw new Error(`${name} doit être une fonction`)
  return value
}

function buildToolResult (name, output, requestId) {
  const parsed = OUTPUTS[name].safeParse(output)
  if (!parsed.success) return toToolErrorResult(new McpAppError('internal'))
  const structured = parsed.data
  const id = requestId ?? null
  const withText = {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured }
  }
  if (measureSerialized(withText) <= RESPONSE_BUDGET_BYTES) return withText.result
  // Trop gros avec le texte dupliqué : `content` reste présent (protocole).
  const minimal = { jsonrpc: '2.0', id, result: { content: [], structuredContent: structured } }
  if (measureSerialized(minimal) <= RESPONSE_BUDGET_BYTES) return minimal.result
  return toToolErrorResult(new McpAppError('internal'))
}

function webRequestFrom (req) {
  const host = req.headers.host ?? `${MCP_HOST}:0`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else if (value != null) headers.set(key, value)
  }
  return new Request(`http://${host}${MCP_ROUTE}`, { method: req.method, headers })
}

/** Sanitise les réponses d'erreur du SDK avant écriture (success inchangé). */
async function writeWebResponse (webRes, res) {
  let buffer = webRes.body ? Buffer.from(await webRes.arrayBuffer()) : Buffer.alloc(0)
  const contentType = (webRes.headers.get('content-type') ?? '')
  if (contentType.includes('application/json') && buffer.length) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'))
      const sanitized = sanitizeProtocolError(parsed)
      if (sanitized !== parsed) buffer = Buffer.from(JSON.stringify(sanitized), 'utf8')
    } catch { /* corps non JSON : laissé tel quel */ }
  }
  res.statusCode = webRes.status
  for (const [key, value] of webRes.headers) {
    if (key.toLowerCase() === 'content-length') continue
    res.setHeader(key, value)
  }
  res.setHeader('content-length', buffer.length)
  res.end(buffer)
}

function createCore ({ handlers, token, logger, dispose, bindHost, bindPort }) {
  const safeHandlers = validateHandlers(handlers)
  const safeToken = resolveToken(token)
  const safeLogger = resolveFunction(logger, 'logger')
  const safeDispose = resolveFunction(dispose, 'dispose')
  const gate = new AdmissionGate()
  const inflight = new Set()
  const inflightWaiters = []
  let closing = false
  let started = false
  let starting = null
  let closePromise = null
  let httpClosePromise = null

  const log = (event) => { if (safeLogger) { try { safeLogger(event) } catch { /* diagnostics only */ } } }
  const track = (req) => inflight.add(req)
  const untrack = (req) => {
    inflight.delete(req)
    if (inflight.size === 0) for (const resolve of inflightWaiters.splice(0)) resolve()
  }
  const waitInflightEmpty = () => inflight.size === 0 ? Promise.resolve() : new Promise((resolve) => inflightWaiters.push(resolve))

  const buildServer = () => {
    const mcp = new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { capabilities: { tools: { listChanged: false } } }
    )
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_LIST }))
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request?.params?.name
      if (typeof name !== 'string' || !Object.hasOwn(VALIDATORS, name)) {
        log({ event: 'tool', outcome: 'unknown_tool' })
        throw new McpError(ErrorCode.InvalidParams, 'unknown tool')
      }
      const startedAt = Date.now()
      let validated
      try {
        validated = VALIDATORS[name](request?.params?.arguments)
      } catch (err) {
        log({ event: 'tool', tool: name, outcome: 'invalid_params', durationMs: Date.now() - startedAt })
        return toToolErrorResult(isMcpAppError(err) ? err : new McpAppError('invalid_params'))
      }
      if (closing || !gate.tryAcquire()) {
        log({ event: 'tool', tool: name, outcome: 'busy', durationMs: Date.now() - startedAt })
        return toToolErrorResult(new McpAppError('busy'))
      }
      try {
        let output
        try {
          output = await safeHandlers[name](validated.value, validated.adaptations)
        } catch (err) {
          log({ event: 'tool', tool: name, outcome: 'internal', durationMs: Date.now() - startedAt })
          return toToolErrorResult(isMcpAppError(err) ? err : new McpAppError('internal'))
        }
        const result = buildToolResult(name, output, extra?.requestId)
        log({ event: 'tool', tool: name, outcome: result.isError ? 'invalid_output' : 'ok', durationMs: Date.now() - startedAt })
        return result
      } finally {
        gate.release()
      }
    })
    return mcp
  }

  const listener = async (req, res) => {
    track(req)
    try {
      if (closing) {
        sendJson(res, 503, { code: 'busy', message: 'arrêt en cours' })
        return
      }
      const addr = httpServer.address()
      const expectedPort = addr && typeof addr === 'object' ? addr.port : null
      const guard = checkRequest({ req, expectedPort, token: safeToken })
      if (!guard.ok) {
        log({ event: 'guard', code: guard.code, status: guard.status })
        sendGuardError(res, guard)
        return
      }
      if (req.url !== MCP_ROUTE) {
        sendJson(res, 404, { code: 'not_found', message: 'route inconnue' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'method_not_allowed', message: 'méthode refusée' })
        return
      }
      const body = await readJsonBody(req, MAX_BODY_BYTES)
      if (closing) {
        sendJson(res, 503, { code: 'busy', message: 'arrêt en cours' })
        return
      }
      if (!body.ok) {
        sendJsonRpcError(res, body.status, null, body.rpcCode, body.message)
        return
      }
      const cls = classifyRequest(body.value)
      if (cls.kind === 'invalid') {
        sendJsonRpcError(res, 200, null, cls.rpcCode, cls.message)
        return
      }
      if (cls.kind === 'invalid_params') {
        sendJsonRpcError(res, 200, cls.id, cls.rpcCode, cls.message)
        return
      }
      if (cls.kind === 'ignored') {
        res.writeHead(202, { 'content-length': '0' }).end()
        return
      }
      if (cls.kind === 'unknown') {
        sendJsonRpcError(res, 200, cls.id, cls.rpcCode, cls.message)
        return
      }
      // Version de protocole prévalidée : la couche SDK recopierait l'en-tête.
      if (cls.method !== 'initialize') {
        const versions = headerValues(req, 'mcp-protocol-version')
        if (versions.length > 1 || (versions.length === 1 && !isSupportedProtocolVersion(versions[0]))) {
          sendJsonRpcError(res, 400, cls.id, -32000, 'Server error')
          return
        }
      }
      try {
        // Stateless : un serveur et un transport NEUFS par requête (exigence SDK).
        const mcp = buildServer()
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        try {
          await mcp.connect(transport)
          const webRes = await transport.handleRequest(webRequestFrom(req), { parsedBody: body.value })
          await writeWebResponse(webRes, res)
        } finally {
          await mcp.close().catch(() => {})
        }
      } catch {
        if (!res.headersSent) sendJson(res, 500, { code: 'internal', message: 'erreur interne bornée' })
      }
    } finally {
      untrack(req)
    }
  }

  const httpServer = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES, keepAlive: true }, (req, res) => {
    listener(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { code: 'internal', message: 'erreur interne bornée' })
    })
  })

  const api = {
    httpServer,
    get active () { return gate.active },
    address () {
      const a = httpServer.address()
      return a && typeof a === 'object' ? { host: a.address, port: a.port } : null
    },
    start () {
      if (closePromise) return Promise.reject(new Error('serveur arrêté'))
      if (starting) return starting
      if (started) return Promise.resolve(api.address())
      starting = new Promise((resolve, reject) => {
        const cleanup = () => {
          httpServer.removeListener('error', onError)
          httpServer.removeListener('listening', onListening)
        }
        const onError = (err) => { cleanup(); starting = null; reject(err) }
        const onListening = () => { cleanup(); started = true; resolve(api.address()) }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen(bindPort, bindHost)
      })
      return starting
    },
    async close () {
      if (closePromise) return closePromise
      closing = true
      closePromise = (async () => {
        if (starting) { try { await starting } catch { /* bind échoué */ } }
        if (started && !httpClosePromise) {
          httpClosePromise = new Promise((resolve) => { httpServer.close(() => resolve()) })
          httpServer.closeIdleConnections?.()
        }
        // Corps en cours : annulés proprement plutôt qu'attendus indéfiniment.
        for (const req of inflight) { if (!req.readableEnded) req.destroy() }
        await gate.waitIdle() // laisse finir le handler actif
        await waitInflightEmpty() // puis la réponse en cours d'écriture
        if (httpClosePromise) await httpClosePromise
        let disposeFailed = false
        if (safeDispose) { try { await safeDispose() } catch { disposeFailed = true } }
        if (disposeFailed) throw new Error('arrêt : dispose a échoué')
      })()
      return closePromise
    }
  }
  return api
}

/**
 * Serveur de PRODUCTION : écoute exclusivement `127.0.0.1:18767`. Toute autre
 * adresse ou port configuré est refusé (`null`/absent = valeur par défaut).
 */
export function createMcpServer (options = {}) {
  const host = options.host ?? MCP_HOST
  const port = options.port ?? MCP_PORT
  if (host !== MCP_HOST) throw new Error('adresse non loopback refusée')
  if (port !== MCP_PORT) throw new Error('port non conforme refusé (18767)')
  return createCore({ ...options, bindHost: MCP_HOST, bindPort: MCP_PORT })
}

/**
 * PRIMITIVE DE TEST uniquement : même serveur sur `127.0.0.1` avec un port OS
 * éphémère (`port 0`). Ne doit jamais servir de point de lancement utilisateur.
 */
export function createMcpTestServer (options = {}) {
  return createCore({ ...options, bindHost: MCP_HOST, bindPort: 0 })
}

export { TOOL_LIST }