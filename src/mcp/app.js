// Fabrique d'application MCP (lot M4) : monte EXACTEMENT les trois handlers réels
// (search/read/status) sur le serveur Streamable HTTP de PRODUCTION
// (`createMcpServer`, `127.0.0.1:18767/mcp`). Aucun second transport, aucune
// installation, aucun autostart, aucune supervision, aucune réparation implicite :
// le lancement est MANUEL (`sdig mcp`) et l'arrêt par SIGINT/SIGTERM ferme le
// serveur puis purge le cache de curseurs read (`dispose`).
//
// `serverFactory` est injectable (tests éphémères, port OS éphémère) : la
// production reste `createMcpServer` par défaut — jamais un port de production
// pendant les tests. Le token vient de `SESSION_DIG_MCP_TOKEN` (jamais affiché).
import { createMcpServer } from './server.js'
import { createSearchHandler } from './search.js'
import { createReadHandler } from './read.js'
import { createStatusHandler } from './status.js'
import { APP_ERROR_REASONS } from './errors.js'
import { corpusRoot, sourceDb, sourcePi } from '../paths.js'

// ── Journal technique : VALEURS ÉNUMÉRÉES ÉPINGLÉES ─────────────────────────
// Le filtre porte sur les CHAMPS **et** sur les VALEURS : un objet ou une chaîne
// arbitraire glissé sous une clé autorisée (ex. `reason`, `tool`) est IGNORÉ, jamais
// recopié. Aucun `query`, filtre, texte, chemin, token ni curseur ne peut donc
// transiter, même via une valeur détournée.
const LOG_EVENTS = new Set(['tool', 'guard'])
const LOG_TOOLS = new Set(['sdig_search', 'sdig_read', 'sdig_status'])
const LOG_OUTCOMES = new Set(['ok', 'invalid_params', 'invalid_output', 'busy', 'unknown_tool', 'internal'])
const LOG_CODES = new Set(['forbidden_host', 'unauthorized', 'busy', 'not_found', 'method_not_allowed', 'internal'])
const LOG_REASONS = new Set([...APP_ERROR_REASONS.view_unavailable, ...APP_ERROR_REASONS.internal])

/** Journal technique stderr par défaut, champs ET valeurs épinglés (aucune fuite). */
export function createSafeLogger (write = (line) => process.stderr.write(`${line}\n`)) {
  return (event) => {
    if (!event || typeof event !== 'object') return
    const safe = {}
    if (LOG_EVENTS.has(event.event)) safe.event = event.event
    if (LOG_TOOLS.has(event.tool)) safe.tool = event.tool
    if (LOG_OUTCOMES.has(event.outcome)) safe.outcome = event.outcome
    if (LOG_CODES.has(event.code)) safe.code = event.code
    if (LOG_REASONS.has(event.reason)) safe.reason = event.reason
    if (Number.isSafeInteger(event.durationMs) && event.durationMs >= 0) safe.durationMs = event.durationMs
    if (Number.isSafeInteger(event.status) && event.status >= 100 && event.status <= 599) safe.status = event.status
    if (Object.keys(safe).length) write(JSON.stringify(safe))
  }
}

// Codes errno d'ÉCOUTE LOCALE reconnus : ensemble **FERMÉ et explicite**. Un code
// arbitraire (ex. `ESKSECRETVALUE`) n'est JAMAIS recopié.
const LISTEN_ERRNOS = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOTSUP', 'EPERM'])

/** Refus de démarrage : code errno PINNÉ, sinon message GÉNÉRIQUE fixe (sans écho). */
export function launchErrorMessage (err) {
  const code = err && typeof err.code === 'string' && LISTEN_ERRNOS.has(err.code) ? err.code : null
  return code ? `mcp : démarrage refusé (${code})` : 'mcp : démarrage refusé'
}

/**
 * Installe l'arrêt MANUEL (SIGINT/SIGTERM) : `server.close()` **terminé**, puis
 * `read.dispose()`, puis sortie 0 ; un échec de fermeture/dispose ⇒ sortie **1** +
 * diagnostic FIXE. Idempotent (garde anti double-cleanup). N'est JAMAIS installé par
 * `createApp` : seul le lanceur manuel (`sdig mcp`) ou un helper de test l'appelle.
 * `stop()` renvoie la promesse d'arrêt (utile aux tests).
 */
export function installAppShutdown (app, {
  exit = (code) => process.exit(code),
  onError = (msg) => process.stderr.write(`${msg}\n`),
  signals = ['SIGINT', 'SIGTERM']
} = {}) {
  let stopping = false
  const stop = () => {
    if (stopping) return Promise.resolve()
    stopping = true
    let failed = false
    return Promise.resolve()
      .then(() => app.server.close())
      .catch(() => { failed = true })
      .then(() => { try { app.read.dispose() } catch { failed = true } })
      .finally(() => {
        if (failed) { onError('sdig mcp : arrêt en échec (fermeture/dispose)'); exit(1) }
        else exit(0)
      })
  }
  for (const s of signals) process.on(s, stop)
  return { stop }
}

/**
 * Construit l'application MCP. `root`/`db`/`piDir` suivent les surcharges usuelles
 * (`--home`/`--db`/`--pi-dir`, env) ; aucun nouveau fichier de configuration agent.
 * Retourne `{ server, read, handlers, config }` — `read.dispose()` purge le cache
 * de curseurs (appelé par `server.close()` via `dispose`).
 */
export function createApp ({
  root = corpusRoot(),
  db = null,
  piDir = null,
  token = process.env.SESSION_DIG_MCP_TOKEN ?? null,
  logger = createSafeLogger(),
  serverFactory = createMcpServer
} = {}) {
  if (typeof serverFactory !== 'function') throw new Error('serverFactory doit être une fonction')
  const config = {
    root,
    sources: {
      opencode: { path: sourceDb(db ?? undefined) },
      pi: { path: sourcePi(piDir ?? undefined) }
    }
  }
  const read = createReadHandler(config)
  const handlers = {
    sdig_search: createSearchHandler(config),
    sdig_read: read,
    sdig_status: createStatusHandler(config)
  }
  const server = serverFactory({ handlers, token, logger, dispose: () => read.dispose() })
  return { server, read, handlers, config }
}
