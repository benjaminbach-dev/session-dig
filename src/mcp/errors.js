// Erreurs applicatives du contrat MCP (lot M1a).
//
// Les erreurs de PROTOCOLE MCP (arguments hors schéma) restent produites par le
// SDK et distinctes. Les erreurs APPLICATIVES ci-dessous portent un code stable ;
// leur représentation sérialisée utilise une liste fermée de messages par code.
//
// Aucune sortie ne doit dépendre du `message` libre d'une exception : une future
// conversion de ces erreurs en résultat d'outil (M1b) devra passer par
// `appErrorPayload`. Les erreurs de protocole du SDK, elles, peuvent recopier des
// clés inconnues ; leur sanitisation est une obligation de M1b, pas un acquis de
// Zod strict.

/** Codes applicatifs stables du MVP (D6). Aucun `timeout` ni `invalid_part`. */
export const APP_ERROR_CODES = Object.freeze([
  'unknown_session',
  'invalid_anchor',
  'invalid_cursor',
  'stale_cursor',
  'invalid_params',
  'view_unavailable',
  'forbidden_host',
  'busy',
  'internal'
])

/** Messages bornés et FIXES par code (jamais dérivés d'une entrée ou d'une exception). */
export const APP_ERROR_MESSAGES = Object.freeze({
  unknown_session: 'session inconnue',
  invalid_anchor: 'ancre invalide',
  invalid_cursor: 'curseur invalide',
  stale_cursor: 'curseur périmé',
  invalid_params: 'paramètres invalides',
  view_unavailable: 'vue indisponible',
  forbidden_host: 'hôte refusé',
  busy: 'service occupé',
  internal: 'erreur interne bornée'
})

const CODE_SET = new Set(APP_ERROR_CODES)

/** Erreur applicative bornée : code stable + message interne (non sérialisé tel quel). */
export class McpAppError extends Error {
  constructor (code) {
    if (!CODE_SET.has(code)) throw new Error(`code d'erreur applicatif inconnu : ${code}`)
    super(APP_ERROR_MESSAGES[code])
    this.name = 'McpAppError'
    this.code = code
  }
}

export function isMcpAppError (err) {
  return err instanceof McpAppError
}

export const invalidParams = () => new McpAppError('invalid_params')
export const invalidCursor = () => new McpAppError('invalid_cursor')
export const invalidAnchor = () => new McpAppError('invalid_anchor')
export const viewUnavailable = () => new McpAppError('view_unavailable')
export const unknownSession = () => new McpAppError('unknown_session')

/** Représentation sérialisable bornée : code + message fixe de la liste fermée. */
export function appErrorPayload (err) {
  // Le code est revérifié contre la liste fermée : une instance McpAppError dont
  // le champ `code` a été muté (ex. valeur secrète) retombe sur `internal`.
  const code = isMcpAppError(err) && CODE_SET.has(err.code) ? err.code : 'internal'
  return { code, message: APP_ERROR_MESSAGES[code] }
}

/**
 * Enveloppe d'erreur d'outil MCP (préparation M1b) : `isError` + charge bornée.
 * Le message libre d'une exception n'est jamais recopié.
 */
export function toToolErrorResult (err) {
  const payload = appErrorPayload(err)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload
  }
}