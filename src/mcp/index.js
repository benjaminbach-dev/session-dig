// Façade MCP : catalogue fermé, schémas, validateurs, garde-fous, accès données
// lecture seule, handlers RÉELS `sdig_search`/`sdig_read`/`sdig_status`, cache de
// curseurs et fabrique d'application (`createApp`, `app.js`). `index.js` n'expose
// aucun serveur démarré : `createApp` monte les trois handlers sur `createMcpServer`
// (`127.0.0.1:18767`) ; le lancement manuel `sdig mcp` est le seul point d'entrée
// utilisateur. Validation LOCALE sur fixtures synthétiques ; validation PC et jalon
// J-MCP NON atteints.
import { TOOL_DEFINITIONS } from './schemas.js'

export * from './constants.js'
export * from './errors.js'
export * from './budget.js'
export * from './schemas.js'
export * from './guards.js'
export * from './admission.js'
export * from './data.js'
export * from './status.js'
export * from './search.js'
export * from './cursor.js'
export * from './read.js'
export * from './app.js'
export * from './server.js'
export { parseStrict, clampCeiling, validateSearchInput, validateReadInput, validateStatusInput } from './validate.js'

/** Plan de configuration (sans handler) pour le SDK officiel. */
export function toolConfigs () {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
    name,
    config: { description, inputSchema, outputSchema, annotations }
  }))
}