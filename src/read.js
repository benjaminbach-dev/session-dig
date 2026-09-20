// Lecture du contexte : dérouler une session autour d'un hit, voir les voisins.
// Retour d'agent 16/09 : « retrouver un extrait n'est pas retrouver la solution » —
// le message trouvé peut être une hypothèse abandonnée ; ses voisins font foi.
//
// Change add-read-at (20/09) : ancrage temporel. Sur une question d'état, la vérité
// terrain est l'état À L'INSTANT où la question a été posée, pas l'état final de la
// session (4 dérives temporelles mesurées au premier passage réel : n05, n44, n46,
// n50). `--at <ancre>` masque les messages postérieurs, rien de plus : l'outil borne
// la lecture dans le temps, il ne détecte ni ne qualifie les changements d'état.
import { loadCorpus } from './corpus.js'
import { fmtTs } from './util.js'

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

const EPOCH_RE = /^\d{13}$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/

/**
 * Résout une ancre (change add-read-at, design D1/D2) :
 *   - un id de message **de la session** → on prend son horodatage ;
 *   - un horodatage : `YYYY-MM-DD` (journée entière visible), `YYYY-MM-DDTHH:MM[:SS]`
 *     ou `YYYY-MM-DD HH:MM` (heure locale, comme l'affichage) ;
 *   - des millisecondes epoch (13 chiffres).
 * Retourne { ts, id } ou { error } — jamais un silence : une ancre fausse doit se voir.
 */
export function resolveAnchor (evs, anchor, allEvents = null) {
  const s = String(anchor ?? '').trim()
  if (!s) return { error: 'ancre vide' }
  if (EPOCH_RE.test(s)) return { ts: Number(s), id: null }
  const m = DATE_RE.exec(s)
  if (m) {
    const [, y, mo, d, h, mi, sec] = m
    const ts = h == null
      // date seule = fin de journée : la journée demandée reste entièrement visible
      ? new Date(+y, +mo - 1, +d, 23, 59, 59, 999).getTime()
      : new Date(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0).getTime()
    if (!Number.isFinite(ts)) return { error: `ancre illisible : ${s}` }
    return { ts, id: null }
  }
  const i = evs.findIndex(e => e.id === s)
  if (i >= 0) return { ts: evs[i].ts, id: s, idx: i }
  const elsewhere = allEvents ? allEvents.find(e => e.id === s) : null
  if (elsewhere) {
    return { error: `l'ancre ${s} appartient à la session ${elsewhere.sessionId}, pas à ${evs[0].sessionId}` }
  }
  return { error: `ancre introuvable : ${s} (id de message de la session, date AAAA-MM-JJ[THH:MM], ou epoch ms)` }
}

/**
 * Vue bornée d'une session par une ancre : les messages d'horodatage ≤ ancre sont
 * visibles (inclusion de l'instant exact — l'ancre vient d'un message, l'exclure
 * rendrait invisible la question elle-même).
 */
export function anchorView (evs, anchor, allEvents = null) {
  const a = resolveAnchor(evs, anchor, allEvents)
  if (a.error) return { error: a.error }
  let maxIdx = -1
  for (let i = 0; i < evs.length; i++) if (evs[i].ts <= a.ts) maxIdx = i
  return {
    maxIdx,
    maskedCount: evs.length - 1 - maxIdx,
    anchor: { id: a.id ?? null, ts: a.ts, date: fmtTs(a.ts), source: a.id ? 'message' : 'horodatage' }
  }
}

/**
 * Tranche d'une session (change add-read-at, design D3) :
 *   1. résolution de l'ancre (`--at`) — erreur fatale si elle est invalide ;
 *   2. masquage des messages postérieurs (la vue) ;
 *   3. fenêtrage `--around`/`--ctx`/`--tail` DANS la vue.
 * Une fenêtre entièrement postérieure à l'ancre est dite explicitement, jamais rendue
 * comme un vide ambigu ; une ancre invalide porte `fatal: true` (sortie non nulle).
 */
export function sessionSlice (root, sessionId, { aroundId, ctx = 10, tail, at } = {}) {
  const { events, sessionsById } = loadCorpus(root)
  const evs = eventsBySession(events).get(sessionId)
  if (!evs) return null
  const ses = sessionsById.get(sessionId) || null

  let view = { maxIdx: evs.length - 1, maskedCount: 0, anchor: null }
  if (at != null && at !== '') {
    const v = anchorView(evs, at, events)
    if (v.error) return { ses, events: evs, spans: [], fatal: true, error: v.error, ...view }
    view = v
  }
  const last = view.maxIdx
  const anchorLabel = view.anchor ? `${view.anchor.id ? `${view.anchor.id} ` : ''}(${view.anchor.date})` : ''

  if (last < 0) {
    return { ses, events: evs, spans: [], ...view, error: `aucun message à ou avant l'ancre ${anchorLabel} — relire sans --at pour voir la session entière` }
  }
  if (aroundId) {
    const idx = evs.findIndex(e => e.id === aroundId)
    if (idx < 0) return { ses, events: evs, spans: [[0, last]], ...view, error: `message ${aroundId} introuvable dans ${sessionId} — ${at ? 'session bornée par l\'ancre' : 'session complète'} affichée` }
    if (idx > last) {
      return { ses, events: evs, spans: [], ...view, error: `fenêtre demandée entièrement postérieure à l'ancre : ${aroundId} est masqué (ancre ${anchorLabel}) — relire sans --at pour voir la session entière` }
    }
    return { ses, events: evs, spans: mergeWindows(last + 1, [idx], ctx), aroundIdx: idx, ...view }
  }
  if (tail != null && last + 1 > tail) {
    return { ses, events: evs, spans: [[last + 1 - tail, last]], ...view }
  }
  return { ses, events: evs, spans: [[0, last]], ...view }
}
