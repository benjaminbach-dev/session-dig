// Garde-fous HTTP du transport MCP (lot M1b).
//
// Fonctions pures (hors lecture du corps) : Host/Origin loopback en syntaxe BRUTE,
// jeton Bearer optionnel (comparaison de digests en temps constant), identifiant
// JSON-RPC borné, classification/sanitisation JSON-RPC et réponses bornées.
// Aucune de ces fonctions ne journalise ni ne recopie une valeur reçue.
import crypto from 'node:crypto'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { MAX_BODY_BYTES, MAX_ID_STRING_CHARS } from './constants.js'

// Syntaxe BRUTE, jamais une normalisation d'URL (qui accepte `127.1`, `%2e`,
// `\`, chemins `..`). Port sans zéro de tête, 1..65535.
const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/i
const ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::([1-9]\d{0,4}))?$/i
const ID_STRING_RE = new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_ID_STRING_CHARS}}$`)
// Méthodes JSON-RPC transmises au serveur SDK (réponses réelles).
const REQUEST_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call'])
// Notifications client reconnues puis acquittées (202), jamais transmises au SDK.
const NOTIFICATION_METHODS = new Set([
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/roots/list_changed'
])
// Messages FERMÉS des erreurs protocolaires (aucun détail SDK recopié).
const PROTOCOL_ERROR_MESSAGES = Object.freeze({
  '-32700': 'Parse error',
  '-32600': 'Invalid Request',
  '-32601': 'Method not found',
  '-32602': 'Invalid params',
  '-32603': 'Internal error',
  '-32000': 'Server error'
})

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** En-têtes dupliqués : tableau distinct (Node ≥ 18.9) sinon valeur unique. */
function distinct (req, name) {
  const d = req.headersDistinct?.[name]
  if (Array.isArray(d)) return d
  const v = req.headers?.[name]
  return v == null ? [] : [v]
}

/** Valeurs distinctes d'un en-tête (tableau ; jamais de valeur jointe). */
export function headerValues (req, name) {
  return distinct(req, name)
}

function validPort (value) {
  if (!/^[1-9]\d{0,4}$/.test(value)) return false
  const n = Number(value)
  return n >= 1 && n <= 65535
}

/**
 * Host admis : `127.0.0.1`, `localhost` ou `[::1]` avec le PORT d'écoute exact,
 * en syntaxe brute (pas de zéro de tête, pas de userinfo/espace/chemin/multiple).
 */
export function parseHostHeader (value, expectedPort) {
  if (typeof value !== 'string' || !value) return false
  const m = HOST_RE.exec(value)
  if (!m) return false
  if (!validPort(m[2])) return false
  return Number(m[2]) === expectedPort
}

/**
 * Origin admis s'il est présent : HTTP(S) loopback en syntaxe BRUTE, sans chemin,
 * slash racine, requête, fragment ni userinfo. Les normalisations trompeuses
 * (`127.1`, `%2e`, `\`, `..`) et les origines multiples sont refusées.
 */
export function isLoopbackOrigin (value) {
  if (typeof value !== 'string' || !value) return false
  const m = ORIGIN_RE.exec(value)
  if (!m) return false
  return m[2] === undefined || validPort(m[2])
}

/** Identifiant JSON-RPC accepté : entier sûr ≥ 0 ou chaîne technique ASCII bornée. */
export function isValidRequestId (id) {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id >= 0
  if (typeof id === 'string') return ID_STRING_RE.test(id)
  return false
}

/**
 * Comparaison de digests SHA-256 de taille FIXE en temps constant
 * (`timingSafeEqual`). Seule la comparaison est en temps constant : le hachage,
 * le parsing des en-têtes et le serveur ne le sont pas — aucune promesse au-delà.
 */
export function constantTimeEqual (a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest()
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest()
  return crypto.timingSafeEqual(ha, hb)
}

/** `Authorization: Bearer <token>` strict : schéma exact, un seul espace, un jeton. */
export function checkBearer (header, token) {
  if (typeof header !== 'string') return false
  const m = /^Bearer ([^\s]+)$/.exec(header)
  if (!m) return false
  return constantTimeEqual(m[1], token)
}

function forbid () {
  return { ok: false, status: 403, code: 'forbidden_host', message: 'hôte refusé' }
}

function unauthorized () {
  return { ok: false, status: 401, code: 'unauthorized', message: 'authentification requise' }
}

/**
 * Contrôle d'une requête AVANT tout travail : Host loopback exact, Origin éventuel
 * loopback, jeton si configuré (le constructeur garantit un jeton non vide).
 */
export function checkRequest ({ req, expectedPort, token }) {
  const hosts = distinct(req, 'host')
  if (hosts.length !== 1 || !parseHostHeader(hosts[0], expectedPort)) return forbid()
  const origins = distinct(req, 'origin')
  if (origins.length > 1 || (origins.length === 1 && !isLoopbackOrigin(origins[0]))) return forbid()
  if (token) {
    const auths = distinct(req, 'authorization')
    if (auths.length !== 1 || !checkBearer(auths[0], token)) return unauthorized()
  }
  return { ok: true }
}

/** Version de protocole supportée par le SDK officiel épinglé. */
export function isSupportedProtocolVersion (value) {
  return typeof value === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(value)
}

/** Paramètres protocolaires connus : structure seule, jamais de valeur recopiée. */
function invalidParams () {
  return { kind: 'invalid_params', rpcCode: -32602, message: 'Invalid params' }
}

function validateParams (method, params) {
  if (method === 'initialize') {
    if (!isPlainObject(params)) return invalidParams()
    if (typeof params.protocolVersion !== 'string') return invalidParams()
    if (params.capabilities !== undefined && !isPlainObject(params.capabilities)) return invalidParams()
    if (!isPlainObject(params.clientInfo)) return invalidParams()
    if (typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') return invalidParams()
    return null
  }
  if (method === 'tools/call') {
    if (!isPlainObject(params)) return invalidParams()
    if (typeof params.name !== 'string' || !params.name) return invalidParams()
    if (params.arguments !== undefined && params.arguments !== null && !isPlainObject(params.arguments)) return invalidParams()
    return null
  }
  if (method === 'tools/list') {
    if (params === undefined || params === null) return null
    if (!isPlainObject(params)) return invalidParams()
    if (params.cursor !== undefined && typeof params.cursor !== 'string') return invalidParams()
    return null
  }
  if (method === 'ping') {
    if (params === undefined || params === null || isPlainObject(params)) return null
    return invalidParams()
  }
  return null
}

/**
 * Classification JSON-RPC d'un corps déjà parsé : requête/notification connue,
 * paramètres connus malformés, méthode inconnue (réponse générique), enveloppe ou
 * identifiant invalides. Jamais de méthode, de valeur ni d'identifiant non borné
 * recopié dans la réponse.
 */
export function classifyRequest (parsed) {
  const invalid = { kind: 'invalid', rpcCode: -32600, message: 'Invalid Request' }
  if (!isPlainObject(parsed)) return invalid
  if (parsed.jsonrpc !== '2.0') return invalid
  if (typeof parsed.method !== 'string' || !parsed.method) return invalid
  const hasId = Object.hasOwn(parsed, 'id')
  if (hasId && !isValidRequestId(parsed.id)) return invalid
  if (NOTIFICATION_METHODS.has(parsed.method)) return { kind: 'ignored' }
  if (!REQUEST_METHODS.has(parsed.method)) {
    return hasId
      ? { kind: 'unknown', id: parsed.id, rpcCode: -32601, message: 'Method not found' }
      : { kind: 'ignored' }
  }
  if (!hasId) return invalid
  const badParams = validateParams(parsed.method, parsed.params)
  if (badParams) return { ...badParams, id: parsed.id }
  return { kind: 'request', id: parsed.id, method: parsed.method }
}

/**
 * Sanitise une charge JSON-RPC de réponse : si elle porte `error`, le code reste
 * (nombre) mais le message vient d'une liste FERMÉE et `data` est supprimé ;
 * l'identifiant est validé (sinon `null`). Les charges de succès sont inchangées.
 */
export function sanitizeProtocolError (payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.error)) return payload
  const rawCode = payload.error.code
  const code = typeof rawCode === 'number' ? rawCode : -32603
  const message = PROTOCOL_ERROR_MESSAGES[String(code)] ?? 'Protocol error'
  return { jsonrpc: '2.0', id: isValidRequestId(payload.id) ? payload.id : null, error: { code, message } }
}

/** Identifiant sûr pour une réponse d'erreur (borné, sinon null). */
export function safeErrorId (id) {
  return isValidRequestId(id) ? id : null
}

/**
 * Lecture bornée du corps puis JSON.parse sans écho. Résout aussi sur corps
 * abandonné/interrompu et retire ses écouteurs (aucune requête attendue sans fin).
 */
export function readJsonBody (req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0
    let done = false
    const chunks = []
    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAbort)
      req.removeListener('close', onClose)
    }
    const finish = (result) => { if (!done) { done = true; cleanup(); resolve(result) } }
    const onData = (chunk) => {
      if (done) return
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, status: 413, rpcCode: -32600, message: 'Request too large' })
        req.resume() // laisse le corps s'écouler ; la réponse 413 part sans écho
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (done) return
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, status: 200, rpcCode: -32700, message: 'Parse error' })
      }
    }
    const onError = () => finish({ ok: false, status: 400, rpcCode: -32600, message: 'Invalid Request' })
    const onAbort = () => finish({ ok: false, status: 400, rpcCode: -32600, message: 'Invalid Request' })
    const onClose = () => { if (!req.readableEnded) onAbort() }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAbort)
    req.on('close', onClose)
  })
}

export function sendJson (res, status, payload) {
  if (res.headersSent || res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function sendJsonRpcError (res, status, id, code, message) {
  sendJson(res, status, sanitizeProtocolError({ jsonrpc: '2.0', id, error: { code, message } }))
}

export function sendGuardError (res, guard) {
  sendJson(res, guard.status, { code: guard.code, message: guard.message })
}