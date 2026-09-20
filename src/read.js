// Lecture du contexte : dérouler une session autour d'un hit, voir les voisins.
// Retour d'agent 16/09 : « retrouver un extrait n'est pas retrouver la solution » —
// le message trouvé peut être une hypothèse abandonnée ; ses voisins font foi.
//
// Change add-read-at (20/09) : ancrage temporel. La vérité terrain est l'état À
// L'INSTANT où la question a été posée, pas l'état final de la session. `--at`
// masque les messages postérieurs, rien de plus.
//
// Change scale-corpus (20/09) : la lecture passe par la VUE dérivable (chemin de
// lecture unique) — fenêtres et compteurs par requêtes bornées sur la clé
// (session_id, ts, id) : le coût dépend de la fenêtre et de la plage comptée, pas
// de la taille du corpus ni de la session. Les lignes de titre (role 'title') ne
// sont jamais comptées ni listées.
//
// Passe corrective 20/09 (revue) :
//   - SNAPSHOT RÉEL : toutes les requêtes d'une commande s'exécutent dans UNE
//     transaction de lecture (inReadTx) — partager une connexion ne partageait PAS
//     une transaction : une publication concurrente pouvait s'intercaler entre hits,
//     voisins et compteurs. En WAL, une transaction de lecture ouverte voit toujours
//     le même snapshot jusqu'à son COMMIT.
//   - FENÊTRES PAR CLÉ (keyset), PAS OFFSET : OFFSET avance en comptant les lignes
//     sautées (coût O(position)) — un --tail ou un --around tardif sur une session
//     géante coûtait la longueur de la session. Chaque fenêtre est bornée par la clé
//     (ts, id) : coût O(fenêtre), quelle que soit la position. Les compteurs restent
//     des dénombrements de plage indexés (coût documenté, mesuré au banc).
import { openView, inReadTx } from './view.js'
import { fmtTs } from './util.js'

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

/** Nombre réel de jours d'un mois (bissextiles incluses). */
function daysInMonth (y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/** Valide les composantes d'une date/heure (change update-read-at, design D2). */
function validateParts ({ y, mo, d, h, mi, s }) {
  if (mo < 1 || mo > 12) return `mois hors bornes (01-12)`
  const max = daysInMonth(y, mo)
  if (d < 1 || d > max) return `jour hors bornes pour ${String(mo).padStart(2, '0')}/${y} (${max} jours)`
  if (h != null && h > 23) return 'heure hors bornes (00-23)'
  if (mi != null && mi > 59) return 'minute hors bornes (00-59)'
  if (s != null && s > 59) return 'seconde hors bornes (00-59)'
  return null
}

/** Forme UTC d'une ancre horodatée : { ts } ou null (pas un horodatage). */
export function parseAnchorTimestamp (s) {
  const m = DATE_RE.exec(s)
  if (!m) return null
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  const h = m[4] == null ? null : +m[4]
  const mi = m[5] == null ? null : +m[5]
  const sec = m[6] == null ? null : +m[6]
  const bad = validateParts({ y, mo, d, h, mi, s: sec })
  if (bad) return { error: `ancre invalide : ${s} (${bad})` }
  // date seule = fin de journée : la journée demandée reste entièrement visible
  const ts = h == null ? Date.UTC(y, mo - 1, d, 23, 59, 59, 999) : Date.UTC(y, mo - 1, d, h, mi, sec ?? 0)
  return { ts }
}

/**
 * Résout une ancre — sur la vue (Database) ou sur des tableaux d'événements
 * (compat tests) — sémantique add-read-at/update-read-at inchangée :
 *   - un id de message **de la session** → son horodatage ;
 *   - un horodatage UTC (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS]`, avec espace), ou
 *     des millisecondes epoch (13 chiffres).
 * Retourne { ts, id } ou { error } — une ancre fausse doit se voir.
 */
export function resolveAnchor (evsOrDb, anchor, allEventsOrDb = null, sessionId = null) {
  const s = String(anchor ?? '').trim()
  if (!s) {
    return { error: 'ancre vide : une valeur vide n\'est pas « pas d\'ancrage » (retirer --at pour lire la session entière)' }
  }
  if (EPOCH_RE.test(s)) return { ts: Number(s), id: null }
  const pt = parseAnchorTimestamp(s)
  if (pt) {
    if (pt.error) return { error: pt.error }
    return { ts: pt.ts, id: null }
  }
  // id de message
  const db = evsOrDb && typeof evsOrDb.prepare === 'function' ? evsOrDb : null
  if (db) {
    const row = db.prepare('SELECT ts, session_id FROM events WHERE id = ?').get(s)
    if (row && row.session_id === sessionId) return { ts: row.ts, id: s }
    if (row) return { error: `l'ancre ${s} appartient à la session ${row.session_id}, pas à ${sessionId}` }
    return { error: `ancre introuvable : ${s} (id de message de la session, date AAAA-MM-JJ[THH:MM] en UTC, ou epoch ms)` }
  }
  const evs = evsOrDb || []
  const i = evs.findIndex(e => e.id === s)
  if (i >= 0) return { ts: evs[i].ts, id: s, idx: i }
  const all = allEventsOrDb || []
  const elsewhere = all.find(e => e.id === s)
  if (elsewhere) {
    return { error: `l'ancre ${s} appartient à la session ${elsewhere.sessionId}, pas à ${evs[0].sessionId}` }
  }
  return { error: `ancre introuvable : ${s} (id de message de la session, date AAAA-MM-JJ[THH:MM] en UTC, ou epoch ms)` }
}

/** Rang d'un message dans sa session (ordre (ts, id), hors titres) — dénombrement indexé. */
export function rankOf (db, sessionId, row) {
  return db.prepare("SELECT COUNT(*) n FROM events WHERE session_id = ? AND role != 'title' AND (ts < ? OR (ts = ? AND id < ?))")
    .get(sessionId, row.ts, row.ts, row.id).n
}

const NON_TITLE = "role != 'title'"

/**
 * Tranche d'une session par la vue (change scale-corpus) :
 *   1. ouverture de la vue (vérification fraîcheur — refus explicite sinon) ;
 *   2. TOUTES les requêtes de la commande dans UNE transaction de lecture (snapshot) ;
 *   3. requêtes bornées : compteurs par dénombrement de plage via l'index (exact,
 *      coût de plage — mesuré au banc, pas caché), fenêtres PAR CLÉ (ts, id) ;
 *   4. sémantique observable inchangée (spans, maxIdx, maskedCount, anchor,
 *      erreurs fatales — tests add-read-at repris tels quels).
 */
export function sessionSlice (root, sessionId, { aroundId, ctx = 10, tail, at } = {}) {
  const db = openView(root)
  try {
    return inReadTx(db, () => sessionSliceDb(db, sessionId, { aroundId, ctx, tail, at }))
  } finally {
    db.close()
  }
}

/** Variante à Database ouverte : la transaction de lecture est portée par l'appelant. */
export function sessionSliceDb (db, sessionId, { aroundId, ctx = 10, tail, at } = {}) {
  const meta = db.prepare('SELECT json FROM sessions WHERE id = ?').get(sessionId)
  if (!meta) return null
  const ses = JSON.parse(meta.json)

  // total de la session (hors lignes de titre) : dénombrement indexé
  const total = db.prepare(`SELECT COUNT(*) n FROM events WHERE session_id = ? AND ${NON_TITLE}`).get(sessionId).n
  if (total === 0) return null

  const countUpTo = (ts) => db.prepare(`SELECT COUNT(*) n FROM events WHERE session_id = ? AND ${NON_TITLE} AND ts <= ?`).get(sessionId, ts).n

  let view = { maxIdx: total - 1, maskedCount: 0, anchor: null }
  // `at` fourni (même vide) n'est jamais ignoré : seul undefined/null = pas d'ancrage
  if (at != null) {
    const a = resolveAnchor(db, at, null, sessionId)
    if (a.error) {
      return { ses, events: [], total, spans: [], fatal: true, error: a.error, ...view }
    }
    const visible = countUpTo(a.ts)
    view = {
      maxIdx: visible - 1,
      maskedCount: total - visible,
      anchor: { id: a.id ?? null, ts: a.ts, date: fmtTs(a.ts), source: a.id ? 'message' : 'horodatage' }
    }
  }
  const last = view.maxIdx
  const anchorLabel = view.anchor ? `${view.anchor.id ? `${view.anchor.id} ` : ''}(${view.anchor.date})` : ''

  // ── fenêtres PAR CLÉ (passe corrective : OFFSET coûtait O(position)) ──
  // La vue entière est un PRÉFIXE de l'ordre (ts, id) : les `last+1` plus petites
  // clés sont exactement la vue visible (un message masqué a toujours une clé
  // supérieure à celle de tout message visible). --tail part de la FIN de la vue
  // visible — DESC borné par l'ancre, puis renversé. --around fetch ses prédécesseurs
  // et successeurs immédiats autour de la clé du message, dans les limites des spans.
  const evsAll = () => db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE} ORDER BY ts, id LIMIT ?`)
    .all(sessionId, last + 1).map(r => JSON.parse(r.json))

  const evsBefore = (row, n) => db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE} AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(sessionId, row.ts, row.ts, row.id, n).map(r => JSON.parse(r.json)).reverse()

  const evsAfter = (row, n) => db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE} AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?`)
    .all(sessionId, row.ts, row.ts, row.id, n).map(r => JSON.parse(r.json))

  const evsTail = (n) => {
    const bound = view.anchor ? ` AND ts <= ${Number(view.anchor.ts)}` : ''
    return db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE}${bound} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(sessionId, n).map(r => JSON.parse(r.json)).reverse()
  }

  if (last < 0) {
    return { ses, events: [], total, spans: [], ...view, error: `aucun message à ou avant l'ancre ${anchorLabel} — relire sans --at pour voir la session entière` }
  }

  if (aroundId) {
    const row = db.prepare('SELECT ts, id FROM events WHERE id = ? AND session_id = ?').get(aroundId, sessionId)
    if (!row) {
      return { ses, events: evsAll(), total, spans: [[0, last]], ...view, error: `message ${aroundId} introuvable dans ${sessionId} — ${at ? 'session bornée par l\'ancre' : 'session complète'} affichée` }
    }
    const idx = rankOf(db, sessionId, row)
    if (idx > last) {
      return { ses, events: [], total, spans: [], aroundIdx: idx, ...view, error: `fenêtre demandée entièrement postérieure à l'ancre : ${aroundId} est masqué (ancre ${anchorLabel}) — relire sans --at pour voir la session entière` }
    }
    const spans = mergeWindows(last + 1, [idx], ctx)
    const a = spans[0][0]
    const b = spans[spans.length - 1][1]
    const before = evsBefore(row, Math.max(0, idx - a)) // prédécesseurs immédiats → [a, idx-1]
    const theRow = [JSON.parse(db.prepare('SELECT json FROM events WHERE id = ?').get(aroundId).json)]
    const after = evsAfter(row, Math.max(0, b - idx)) // successeurs immédiats → [idx+1, b]
    return { ses, events: [...before, ...theRow, ...after], total, spans, aroundIdx: idx, ...view }
  }

  if (tail != null && last + 1 > tail) {
    const evs = evsTail(tail)
    const from = last + 1 - evs.length
    return { ses, events: evs, total, spans: [[from, last]], ...view }
  }
  return { ses, events: evsAll(), total, spans: [[0, last]], ...view }
}

/**
 * Voisins de hits pour la recherche --ctx (passe corrective 20/09) : fenêtres PAR
 * CLÉ autour de chaque hit (jamais OFFSET, jamais rankOf par rang — le rang du hit
 * est dénombré une fois, les voisins sont les prédécesseurs/successeurs immédiats
 * de sa clé, leurs rangs absolus se déduisent donc sans recomptage). Retourne
 * Map sessionId → { total, evs (dense), absIdx (rang absolu de chaque ev) } :
 * l'empreinte mémoire dépend des fenêtres, pas de la taille de la session
 * (l'ancienne version allouait un tableau de la longueur TOTALE de la session).
 */
export function neighborsBySessionDb (db, sessionId, hitRows, ctx) {
  const total = db.prepare(`SELECT COUNT(*) n FROM events WHERE session_id = ? AND ${NON_TITLE}`).get(sessionId).n
  const map = new Map()
  if (!total) return map
  const byKey = new Map() // `${ts}|${id}` → { abs, ev }
  const put = (abs, ev) => { const k = `${ev.ts}|${ev.id}`; if (!byKey.has(k)) byKey.set(k, { abs, ev }) }
  for (const h of hitRows) {
    const rank = rankOf(db, sessionId, h)
    if (h.role !== 'title') {
      const hit = db.prepare(`SELECT json FROM events WHERE id = ? AND session_id = ? AND ${NON_TITLE}`).get(h.id, sessionId)
      if (hit) put(rank, JSON.parse(hit.json))
    }
    // un hit « title » n'est pas dans la séquence des messages : ses successeurs
    // commencent au rang `rank` ; un hit message EST au rang `rank`.
    const succBase = h.role === 'title' ? rank : rank + 1
    const beforeN = Math.min(ctx, rank)
    const rows = db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE} AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(sessionId, h.ts, h.ts, h.id, beforeN)
    rows.forEach((r, i) => put(rank - 1 - i, JSON.parse(r.json))) // DESC : le plus proche d'abord
    const rows2 = db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE} AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?`)
      .all(sessionId, h.ts, h.ts, h.id, ctx)
    rows2.forEach((r, i) => put(succBase + i, JSON.parse(r.json)))
  }
  const entries = [...byKey.values()].sort((x, y) => x.abs - y.abs)
  map.set(sessionId, {
    total,
    evs: entries.map(e => e.ev),
    absIdx: entries.map(e => e.abs)
  })
  return map
}
