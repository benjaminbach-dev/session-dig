// Mesure du budget de réponse (lot M1a).
//
// Contrat d'enveloppe uniquement : mesurer la taille UTF-8 d'une réponse MCP
// sérialisée pour la comparer au plafond global (D3). Aucune fragmentation ni
// découpe de texte n'est implémentée ici (hors M1a).
import { RESPONSE_BUDGET_BYTES } from './constants.js'

/** Taille UTF-8 exacte d'une chaîne, ou de la représentation JSON d'une valeur. */
export function utf8Bytes (value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

/** Taille UTF-8 de la représentation JSON d'une valeur (réponse sérialisée). */
export function measureSerialized (value) {
  return utf8Bytes(JSON.stringify(value))
}

/** La représentation sérialisée tient-elle dans le budget global ? */
export function fitsBudget (value, budget = RESPONSE_BUDGET_BYTES) {
  return measureSerialized(value) <= budget
}