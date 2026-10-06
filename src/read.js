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
import { openView, inReadTx, checkFresh } from './view.js'
import { fmtTs, utcFromParts } from './util.js'

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

/** Bissextile PROLEPTIQUE (grégorienne), exacte pour les années 0–99 (année 0 bissextile). */
function isLeapYear (y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

/** Nombre réel de jours d'un mois (bissextiles incluses), exact pour toutes les années. */
function daysInMonth (y, mo) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
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
  // date seule = fin de journée : la journée demandée reste entièrement visible.
  // `utcFromParts` préserve les années 0–99 (Date.UTC les mapperait sur 1900–1999).
  const ts = h == null ? utcFromParts(y, mo - 1, d, 23, 59, 59, 999) : utcFromParts(y, mo - 1, d, h, mi, sec ?? 0)
  return { ts }
}

/** Filtre PARTAGÉ : les lignes de titre synthétiques ne sont jamais des messages. */
export const NON_TITLE = "role != 'title'"

/** Défaut PARTAGÉ du contexte autour d'un hit (parité CLI) : `ctx` absent vaut 10. */
export const DEFAULT_READ_CTX = 10

/**
 * Résout une ancre — sur la vue (Database) ou sur des tableaux d'événements
 * (compat tests) — sémantique add-read-at/update-read-at inchangée :
 *   - un id de message **de la session** → son horodatage ;
 *   - un horodatage UTC (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS]`, avec espace), ou
 *     des millisecondes epoch (13 chiffres).
 * Retourne { ts, id } ou { error } — une ancre fausse doit se voir.
 * Une ligne SYNTHÉTIQUE de titre (`role = 'title'`, id = id de session) n'est PAS un
 * message : elle n'est jamais acceptée comme ancre (ni par id, ni par la recherche
 * de la session d'appartenance).
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
    const row = db.prepare(`SELECT ts, session_id FROM events WHERE id = ? AND ${NON_TITLE}`).get(s)
    if (row && row.session_id === sessionId) return { ts: row.ts, id: s }
    if (row) return { error: `l'ancre ${s} appartient à la session ${row.session_id}, pas à ${sessionId}` }
    return { error: `ancre introuvable : ${s} (id de message de la session, date AAAA-MM-JJ[THH:MM] en UTC, ou epoch ms)` }
  }
  const evs = evsOrDb || []
  const i = evs.findIndex(e => e.id === s && e.role !== 'title')
  if (i >= 0) return { ts: evs[i].ts, id: s, idx: i }
  const all = allEventsOrDb || []
  const elsewhere = all.find(e => e.id === s && e.role !== 'title')
  if (elsewhere) {
    return { error: `l'ancre ${s} appartient à la session ${elsewhere.sessionId}, pas à ${evs[0].sessionId}` }
  }
  return { error: `ancre introuvable : ${s} (id de message de la session, date AAAA-MM-JJ[THH:MM] en UTC, ou epoch ms)` }
}

/** Rang d'un message dans sa session (ordre (ts, id), hors titres) — dénombrement indexé. */
export function rankOf (db, sessionId, row) {
  return db.prepare(`SELECT COUNT(*) n FROM events WHERE session_id = ? AND ${NON_TITLE} AND (ts < ? OR (ts = ? AND id < ?))`)
    .get(sessionId, row.ts, row.ts, row.id).n
}

/**
 * Tranche d'une session par la vue (change scale-corpus) :
 *   1. ouverture de la vue (vérification fraîcheur — refus explicite sinon) ;
 *   2. TOUTES les requêtes de la commande dans UNE transaction de lecture (snapshot) ;
 *   3. requêtes bornées : compteurs par dénombrement de plage via l'index (exact,
 *      coût de plage — mesuré au banc, pas caché), fenêtres PAR CLÉ (ts, id) ;
 *   4. sémantique observable inchangée (spans, maxIdx, maskedCount, anchor,
 *      erreurs fatales — tests add-read-at repris tels quels).
 */
export function sessionSlice (root, sessionId, { aroundId, ctx = DEFAULT_READ_CTX, tail, at } = {}) {
  const db = openView(root)
  try {
    return inReadTx(db, () => sessionSliceDb(db, sessionId, { aroundId, ctx, tail, at }), { root })
  } finally {
    db.close()
  }
}

/**
 * Chemin de LECTURE EN FLUX (change scale-corpus, sous-partie « read complet ») :
 * MÊME résolution que `sessionSliceDb` (fenêtres keyset, ancre inclusive, compteurs
 * de plage, avertissements/erreurs), mais ne matérialise JAMAIS la session — les
 * événements sont rendus par l'itérateur PARESSEUX `Statement.iterate()`, un à la
 * fois. Le coût mémoire du parcours est borné par la fenêtre et par un événement
 * rendu (jamais par la session ni le corpus) ; la taille d'un événement, elle,
 * reste une borne (pas de promesse « mémoire indépendante de la taille
 * événement »).
 *
 * Snapshot : UNE transaction de lecture (`BEGIN`) reste ouverte pendant TOUTE la
 * consommation — y compris à travers les attentes de backpressure de stdout — puis
 * `COMMIT`. L'API synchrone `inReadTx` ne peut pas attendre un consommateur
 * asynchrone : la transaction est donc pilotée ici, avec la même revalidation de
 * fraîcheur, `ROLLBACK` sur erreur ou sortie anticipée. `iter.return()` est
 * TOUJOURS appelé AVANT `COMMIT`/`ROLLBACK` (better-sqlite3 refuse toute autre
 * instruction sur une connexion occupée par un itérateur vivant) et la connexion
 * est fermée dans tous les cas.
 *
 * Contrepartie assumée : une transaction de lecture ouverte retient le snapshot
 * WAL tant que le consommateur tire ses octets (un pipe lent retarde le checkpoint
 * WAL). Ce coût est documenté, pas caché.
 *
 * Yield : `{ kind: 'window', window }` (window `null` = session inconnue), puis
 * `{ kind: 'event', index, event }` dans l'ordre (ts, id) des spans (un span :
 * `around`/`tail`/`all`). Semantique et comptes identiques à `sessionSlice`.
 */
export async function * streamRead (root, sessionId, { aroundId, ctx = DEFAULT_READ_CTX, tail, at } = {}) {
  const db = openView(root)
  let begun = false
  let iter = null
  let done = false
  let failure = null
  try {
    // BEGIN DANS le try : une erreur de BEGIN laisse la connexion refermée par
    // le finally (aucune fuite de descripteur).
    db.exec('BEGIN')
    begun = true
    // Même revalidation que `inReadTx` : `openView` a vérifié la fraîcheur avant
    // le BEGIN, une publication a pu s'intercaler depuis — le snapshot lui-même
    // est revalidé avant toute donnée rendue.
    const fresh = checkFresh(root, { db })
    if (!fresh.fresh) throw new Error(fresh.reason)
    const w = resolveReadWindowDb(db, sessionId, { aroundId, ctx, tail, at })
    // Parité avec `sessionSlice`/`sessionSliceDb` : une session SANS message
    // (total 0) rend `null` côté CLI (comportement préservé).
    yield { kind: 'window', window: w && w.total === 0 ? null : w }
    if (w && !w.fatal && w.mode !== 'empty' && w.mode !== 'around-masked') {
      iter = eventsIter(db, sessionId, w)
      let i = w.spans.length ? w.spans[0][0] : 0
      for (const row of iter) {
        yield { kind: 'event', index: i, event: JSON.parse(row.json) }
        i++
      }
    }
    // Itérateur lâché AVANT le COMMIT (connexion non occupée). Une erreur de
    // `return()` n'est PAS avalée : elle empêche le COMMIT et remonte au
    // consommateur — le finally referme la connexion.
    if (iter) { iter.return?.(); iter = null }
    db.exec('COMMIT')
    done = true
  } catch (err) {
    failure = err
    throw err
  } finally {
    // Toujours tenter tous les nettoyages. Une erreur d'origine prime ; sans
    // erreur d'origine, un échec de nettoyage doit rester visible au consommateur.
    let cleanupError = null
    if (iter) { try { iter.return?.() } catch (err) { cleanupError = err } }
    if (begun && !done) { try { db.exec('ROLLBACK') } catch (err) { cleanupError ??= err } }
    try { db.close() } catch (err) { cleanupError ??= err }
    if (!failure && cleanupError) throw cleanupError
  }
}

/**
 * Itérateur PARESSEUX (`Statement.iterate()`) des événements complets de la
 * fenêtre résolue : bornes keyset EXACTES (mêmes SQL que `eventsAllFor`/
 * `eventsForKeys`), un seul `json` d'événement vivant à la fois. Jamais `.all()`.
 */
function eventsIter (db, sessionId, w) {
  if (w.mode === 'all') {
    return db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE} ORDER BY ts, id LIMIT ?`)
      .iterate(sessionId, w.maxIdx + 1)
  }
  const keys = w.keys
  if (!keys.length) return [][Symbol.iterator]()
  const first = keys[0]
  const last = keys[keys.length - 1]
  return db.prepare(`SELECT json FROM events WHERE session_id = @sid AND ${NON_TITLE} AND (ts > @fts OR (ts = @fts AND id >= @fid)) AND (ts < @lts OR (ts = @lts AND id <= @lid)) ORDER BY ts, id`)
    .iterate({ sid: sessionId, fts: first.ts, fid: first.id, lts: last.ts, lid: last.id })
}

/** Variante à Database ouverte : la transaction de lecture est portée par l'appelant. */
export function sessionSliceDb (db, sessionId, { aroundId, ctx = DEFAULT_READ_CTX, tail, at } = {}) {
  const w = resolveReadWindowDb(db, sessionId, { aroundId, ctx, tail, at })
  if (!w) return null
  // CLI : une session sans message (total 0) rend `null` (comportement préservé) ;
  // `resolveReadWindowDb` la RECONNAÎT (objet) pour la future fidélité read vide.
  if (w.total === 0) return null
  const out = {
    ses: w.ses,
    events: [],
    total: w.total,
    spans: w.spans,
    maxIdx: w.maxIdx,
    maskedCount: w.maskedCount,
    anchor: w.anchor
  }
  if (w.aroundIdx != null) out.aroundIdx = w.aroundIdx
  if (w.fatal) { out.fatal = true; out.error = w.error; return out }
  if (w.mode === 'empty' || w.mode === 'around-masked') { out.error = w.warning; return out }
  if (w.mode === 'around' || w.mode === 'tail') { out.events = eventsForKeys(db, sessionId, w.keys); return out }
  // mode 'all' : chargement intégral de la vue visible (fait de code du CLI, pas un
  // contrat — la pagination keyset MCP passe par `pageKeys`).
  out.events = eventsAllFor(db, sessionId, w.maxIdx)
  if (w.warning) out.error = w.warning
  return out
}

// ── M3b1 : primitives PARTAGÉES de fenêtre/pagination (métadonnées + clés) ───
// `resolveReadWindowDb` lit UNIQUEMENT des métadonnées (méta de session, compteurs,
// ancre via `resolveAnchor` partagé, mode/spans/rangs) et, pour `around`/`tail`, la
// liste BORNÉE des clés `(ts, id)` — jamais de `json`/`text` d'événement, jamais de
// session matérialisée. Le CLI la consomme pour rester identique ; le futur handler
// MCP s'en servira pour la pagination keyset.

/** Clés (ts, id) strictement avant une clé, ordre ascendant, ≤ n. */
function keysBefore (db, sessionId, row, n) {
  if (n <= 0) return []
  return db.prepare(`SELECT ts, id FROM events WHERE session_id = ? AND ${NON_TITLE} AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(sessionId, row.ts, row.ts, row.id, n).reverse()
}

/** Clés (ts, id) strictement après une clé, ordre ascendant, ≤ n. */
function keysAfter (db, sessionId, row, n) {
  if (n <= 0) return []
  return db.prepare(`SELECT ts, id FROM events WHERE session_id = ? AND ${NON_TITLE} AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT ?`)
    .all(sessionId, row.ts, row.ts, row.id, n)
}

/** Clés des `n` derniers messages de la vue visible (borne ancre inclusive), ascendant. */
function keysTail (db, sessionId, n, anchor) {
  const bound = anchor ? ' AND ts <= @anchorTs' : ''
  const sql = `SELECT ts, id FROM events WHERE session_id = @sid AND ${NON_TITLE}${bound} ORDER BY ts DESC, id DESC LIMIT @n`
  const params = anchor ? { sid: sessionId, anchorTs: anchor.ts, n } : { sid: sessionId, n }
  return db.prepare(sql).all(params).reverse()
}

/** Événements complets de la vue visible (≤ maxIdx+1), ordre (ts, id). */
function eventsAllFor (db, sessionId, maxIdx) {
  return db.prepare(`SELECT json FROM events WHERE session_id = ? AND ${NON_TITLE} ORDER BY ts, id LIMIT ?`)
    .all(sessionId, maxIdx + 1).map((r) => JSON.parse(r.json))
}

/** Événements complets d'une fenêtre CONTIGUË de clés, par bornes keyset inclusives. */
function eventsForKeys (db, sessionId, keys) {
  if (!keys.length) return []
  const first = keys[0]
  const last = keys[keys.length - 1]
  return db.prepare(`SELECT json FROM events WHERE session_id = @sid AND ${NON_TITLE} AND (ts > @fts OR (ts = @fts AND id >= @fid)) AND (ts < @lts OR (ts = @lts AND id <= @lid)) ORDER BY ts, id`)
    .all({ sid: sessionId, fts: first.ts, fid: first.id, lts: last.ts, lid: last.id })
    .map((r) => JSON.parse(r.json))
}

/**
 * Fenêtre de lecture RÉSOLUE, SANS événements complets. Retourne `null` si la
 * session est inconnue. Sinon :
 *   { ses, total, visible, maskedCount, anchor, maxIdx, spans, mode, keys,
 *     aroundIdx, warning, fatal, error }
 * `mode` ∈ 'all' | 'tail' | 'around' | 'around-masked' | 'empty' | 'fatal'.
 * `keys` n'est rempli que pour `around`/`tail` (borné) ; `all` ne matérialise
 * AUCUNE clé (pagination via `pageKeys`). `total === 0` reste un objet reconnu.
 */
export function resolveReadWindowDb (db, sessionId, { aroundId, ctx = DEFAULT_READ_CTX, tail, at } = {}) {
  const meta = db.prepare('SELECT json FROM sessions WHERE id = ?').get(sessionId)
  if (!meta) return null
  const ses = JSON.parse(meta.json)

  const total = db.prepare(`SELECT COUNT(*) n FROM events WHERE session_id = ? AND ${NON_TITLE}`).get(sessionId).n

  const base = { ses, total, visible: total, maskedCount: 0, anchor: null, maxIdx: total - 1, spans: [], mode: 'all', keys: [], aroundIdx: null, warning: null, fatal: false, error: null }

  const countUpTo = (ts) => db.prepare(`SELECT COUNT(*) n FROM events WHERE session_id = ? AND ${NON_TITLE} AND ts <= ?`).get(sessionId, ts).n

  // `at` est TOUJOURS validé, MÊME pour une session vide (total 0) : une date
  // invalide, un id inconnu ou d'une AUTRE session est refusé (`fatal`) ; un
  // horodatage valide expose l'ancre avec `maskedCount: 0` sur une vue vide — base
  // de la future lecture pi vide fidèle. Le wrapper CLI garde `total 0 ⇒ null`.
  if (at != null) {
    const a = resolveAnchor(db, at, null, sessionId)
    if (a.error) return { ...base, spans: [], mode: 'fatal', fatal: true, error: a.error }
    const visible = countUpTo(a.ts)
    base.visible = visible
    base.maskedCount = total - visible
    base.anchor = { id: a.id ?? null, ts: a.ts, date: fmtTs(a.ts), source: a.id ? 'message' : 'horodatage' }
    base.maxIdx = visible - 1
  }
  const last = base.maxIdx
  const anchorLabel = base.anchor ? `${base.anchor.id ? `${base.anchor.id} ` : ''}(${base.anchor.date})` : ''

  if (last < 0) {
    return { ...base, spans: [], mode: 'empty', warning: at != null ? `aucun message à ou avant l'ancre ${anchorLabel} — relire sans --at pour voir la session entière` : null }
  }

  if (aroundId) {
    // Un id de ligne de TITRE n'est pas un message : jamais accepté comme `around`.
    const row = db.prepare(`SELECT ts, id FROM events WHERE id = ? AND session_id = ? AND ${NON_TITLE}`).get(aroundId, sessionId)
    if (!row) {
      return { ...base, spans: [[0, last]], mode: 'all', warning: `message ${aroundId} introuvable dans ${sessionId} — ${at ? 'session bornée par l\'ancre' : 'session complète'} affichée` }
    }
    const idx = rankOf(db, sessionId, row)
    if (idx > last) {
      return { ...base, spans: [], mode: 'around-masked', aroundIdx: idx, warning: `fenêtre demandée entièrement postérieure à l'ancre : ${aroundId} est masqué (ancre ${anchorLabel}) — relire sans --at pour voir la session entière` }
    }
    const spans = mergeWindows(last + 1, [idx], ctx)
    const a = spans[0][0]
    const b = spans[spans.length - 1][1]
    const keys = [
      ...keysBefore(db, sessionId, row, Math.max(0, idx - a)),
      { ts: row.ts, id: row.id },
      ...keysAfter(db, sessionId, row, Math.max(0, b - idx))
    ]
    return { ...base, spans, mode: 'around', keys, aroundIdx: idx }
  }

  if (tail != null && last + 1 > tail) {
    const keys = keysTail(db, sessionId, tail, base.anchor)
    const from = last + 1 - keys.length
    return { ...base, spans: [[from, last]], mode: 'tail', keys }
  }
  return { ...base, spans: [[0, last]], mode: 'all' }
}

/**
 * Page de CLÉS `(ts, id)` par KEYSET — jamais d'`OFFSET`. Au plus `limit` (plafonné
 * à 200) clés, plus 1 « lookahead » pour savoir s'il reste une suite. Bornée
 * optionnellement par l'ancre (`ts <= anchorTs`, inclusif). Aucun `json`/`text`
 * chargé. La fragmentation (offsets en points de code) relève du lot suivant.
 * `after` = clé `{ ts, id }` strictement dépassée, ou `null` pour repartir du début.
 */
export function pageKeys (db, sessionId, { after = null, limit = 200, anchorTs = null } = {}) {
  const n = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 200, 200))
  const where = ['session_id = @sid', NON_TITLE]
  const params = { sid: sessionId, n: n + 1 }
  if (after) { where.push('(ts > @ats OR (ts = @ats AND id > @aid))'); params.ats = after.ts; params.aid = after.id }
  if (anchorTs != null) { where.push('ts <= @anchorTs'); params.anchorTs = anchorTs }
  const rows = db.prepare(`SELECT ts, id FROM events WHERE ${where.join(' AND ')} ORDER BY ts, id LIMIT @n`).all(params)
  const hasMore = rows.length > n
  return { keys: hasMore ? rows.slice(0, n) : rows, hasMore }
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
