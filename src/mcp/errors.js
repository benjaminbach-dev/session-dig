// Erreurs applicatives du contrat MCP (lot M1a).
//
// Les erreurs de PROTOCOLE MCP (arguments hors schéma) restent distinctes. Le
// transport M1b n'emprunte pas la validation Zod du SDK pour `tools/call` : c'est
// la couche applicative (validateurs M1a) qui produit `invalid_params`, et la
// représentation sérialisée utilise une liste fermée de messages par code.
//
// Aucune sortie ne doit dépendre du `message` libre d'une exception : la
// conversion en résultat d'outil passe par `appErrorPayload`, et le résultat
// d'erreur ne porte PAS de `structuredContent` (un client officiel le validerait
// contre le schéma de sortie).

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

// Raisons techniques DISTINGUÉES, par ensemble FERMÉ et sans écho : jamais un
// message de bibliothèque, un chemin ou un contenu. Elles qualifient un refus
// (`view_unavailable`) ou un échec interne de la couche de données.
export const APP_ERROR_REASONS = Object.freeze({
  view_unavailable: Object.freeze([
    'missing_view',
    'invalid_schema',
    'missing_state',
    'stale_view',
    'pi_divergence',
    'changed_publication'
  ]),
  internal: Object.freeze([
    'async_callback',
    'unsupported_callback',
    'callback_failed',
    'invalid_config'
  ])
})

const REASON_SET = new Set(Object.values(APP_ERROR_REASONS).flat())

/** La raison appartient-elle à l'ensemble fermé (et au code) ? */
function reasonAllowed (code, reason) {
  return reason != null && Array.isArray(APP_ERROR_REASONS[code]) && APP_ERROR_REASONS[code].includes(reason)
}

/** Erreur applicative bornée : code stable + raison fermée optionnelle. */
export class McpAppError extends Error {
  constructor (code, reason = null) {
    if (!CODE_SET.has(code)) throw new Error(`code d'erreur applicatif inconnu : ${code}`)
    if (reason != null && !REASON_SET.has(reason)) throw new Error('raison d\'erreur applicative inconnue')
    super(APP_ERROR_MESSAGES[code])
    this.name = 'McpAppError'
    this.code = code
    this.reason = reasonAllowed(code, reason) ? reason : null
  }
}

export function isMcpAppError (err) {
  return err instanceof McpAppError
}

export const invalidParams = () => new McpAppError('invalid_params')
export const invalidCursor = () => new McpAppError('invalid_cursor')
export const invalidAnchor = () => new McpAppError('invalid_anchor')
export const viewUnavailable = (reason = null) => new McpAppError('view_unavailable', reason)
export const unknownSession = () => new McpAppError('unknown_session')
export const internalError = (reason = null) => new McpAppError('internal', reason)

/** Représentation sérialisable bornée : code + message fixe + raison fermée éventuelle. */
export function appErrorPayload (err) {
  // Le code ET la raison sont revérifiés contre les listes fermées : une instance
  // McpAppError dont un champ a été muté (valeur secrète) retombe sur `internal`.
  const code = isMcpAppError(err) && CODE_SET.has(err.code) ? err.code : 'internal'
  const payload = { code, message: APP_ERROR_MESSAGES[code] }
  if (isMcpAppError(err) && reasonAllowed(code, err.reason)) payload.reason = err.reason
  return payload
}

/**
 * Enveloppe d'erreur d'outil MCP (transport M1b) : `isError` + charge bornée.
 * AUCUN `structuredContent` : un client officiel qui a mis en cache le schéma de
 * sortie validerait ce contenu et refuserait l'erreur. Le code applicatif reste
 * lisible dans le texte.
 */
export function toToolErrorResult (err) {
  const payload = appErrorPayload(err)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }]
  }
}