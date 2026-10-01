// Façade de contrats MCP (lot M1a).
//
// Expose le catalogue fermé, ses schémas et ses validateurs. Ne démarre AUCUN
// serveur, ne se connecte à aucun transport et n'implémente aucun handler
// search/read/status : M1 (transport + contrat complet) reste incomplet. Les
// configurations sont prêtes pour `McpServer.registerTool(name, config, handler)`.
import { TOOL_DEFINITIONS } from './schemas.js'

export * from './constants.js'
export * from './errors.js'
export * from './budget.js'
export * from './schemas.js'
export * from './guards.js'
export * from './admission.js'
export * from './data.js'
export * from './server.js'
export { parseStrict, clampCeiling, validateSearchInput, validateReadInput, validateStatusInput } from './validate.js'

/** Plan de configuration (sans handler) pour le SDK officiel. */
export function toolConfigs () {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
    name,
    config: { description, inputSchema, outputSchema, annotations }
  }))
}