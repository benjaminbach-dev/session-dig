// Façade de contrats MCP (lot M1a).
//
// Expose le catalogue fermé, ses schémas, ses validateurs, les garde-fous, la
// fabrique de serveur et l'ACCÈS DONNÉES. Ne démarre AUCUN serveur et ne se
// connecte à aucun transport. Le handler `sdig_status` est livré (sous-lot
// status) ; les handlers `sdig_search`/`sdig_read` ne le sont pas : M1 reste
// incomplet, M3 n'est pas atteint. Les configurations sont prêtes pour
// `McpServer.registerTool(name, config, handler)`.
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
export * from './server.js'
export { parseStrict, clampCeiling, validateSearchInput, validateReadInput, validateStatusInput } from './validate.js'

/** Plan de configuration (sans handler) pour le SDK officiel. */
export function toolConfigs () {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
    name,
    config: { description, inputSchema, outputSchema, annotations }
  }))
}