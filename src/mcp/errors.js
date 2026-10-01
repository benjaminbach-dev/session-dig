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