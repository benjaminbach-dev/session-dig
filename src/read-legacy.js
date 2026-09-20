// Compat change scale-corpus : le regroupement/lecture par session se fait désormais
// depuis la vue (requêtes bornées). Les tests utilisent un adaptateur local.
import { loadCorpus } from '../src/corpus.js'

// Compat change scale-corpus : les tests hérités utilisent sessionSlice sur des
// tableaux ; la lecture de commande passe par la vue. On réexporte la vue + l'hérité.
export { sessionSlice, resolveAnchor, parseAnchorTimestamp, mergeWindows } from '../src/read.js'

/**
 * eventsBySession(events) : regroupe des événements déjà triés par (sessionId, ts, id)
 * — conservé pour les tests à échelle minuscule (jamais sur les chemins de commande).
 */
export function eventsBySession (events) {
  const map = new Map()
  for (const e of events) {
    if (!map.has(e.sessionId)) map.set(e.sessionId, [])
    map.get(e.sessionId).push(e)
  }
  return map
}
