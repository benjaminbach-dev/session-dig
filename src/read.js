// Lecture du contexte : dérouler une session autour d'un hit, voir les voisins.
// Retour d'agent 16/09 : « retrouver un extrait n'est pas retrouver la solution » —
// le message trouvé peut être une hypothèse abandonnée ; ses voisins font foi.
import { loadCorpus } from './corpus.js'

export function eventsBySession (events) {
  const map = new Map()
  for (const e of events) {
    if (!map.has(e.sessionId)) map.set(e.sessionId, [])
    map.get(e.sessionId).push(e)
  }
  return map // évènements déjà triés (sessionId, ts, id) dans le corpus
}

/** Fusionne les fenêtres [i-ctx, i+ctx] autour des index de hits. */
export function mergeWindows (length, hitIdxs, ctx) {
  const spans = hitIdxs.map(i => [Math.max(0, i - ctx), Math.min(length - 1, i + ctx)])
    .sort((a, b) => a[0] - b[0])
  const merged = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1])
    else merged.push([...s])
  }
  return merged
}

/**
 * Tranche d'une session : autour d'un message (--around) avec rayon ctx,
 * ou queue (--tail N). Retourne { events, spans } — spans = fenêtres conservées.
 */
export function sessionSlice (root, sessionId, { aroundId, ctx = 10, tail } = {}) {
  const { events, sessionsById } = loadCorpus(root)
  const evs = eventsBySession(events).get(sessionId)
  if (!evs) return null
  const ses = sessionsById.get(sessionId) || null
  if (aroundId) {
    const idx = evs.findIndex(e => e.id === aroundId)
    if (idx < 0) return { ses, events: evs, spans: [[0, evs.length - 1]], error: `message ${aroundId} introuvable dans ${sessionId} — session complète affichée` }
    return { ses, events: evs, spans: mergeWindows(evs.length, [idx], ctx), aroundIdx: idx }
  }
  if (tail != null && evs.length > tail) {
    return { ses, events: evs, spans: [[evs.length - tail, evs.length - 1]] }
  }
  return { ses, events: evs, spans: [[0, evs.length - 1]] }
}
