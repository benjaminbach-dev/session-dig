// Handler MÉTIER `sdig_read` (sous-lot M3b2). Lecture seule, pagination KEYSET et
// FRAGMENTS bornés DANS SQL avant tout transfert JS : jamais de `SELECT json` ni de
// texte complet chargé en JS. S'appuie sur les primitives partagées
// `resolveReadWindowDb`/`pageKeys` (src/read.js) : aucune duplication de la logique
// d'ancre/fenêtre/rang.
//
// Curseurs : opaques, inertes, liés à l'outil, à la requête initiale, à la position,
// à l'ancre/fenêtre ET à l'identité de génération publiée (`readIdentity`). Un
// changement de génération pendant la suite donne `stale_cursor` ; un jeton inconnu,
// altéré, étranger, expiré, évincé ou perdu au redémarrage donne `invalid_cursor`.
// L'état est gardé dans un cache process-local borné (`src/mcp/cursor.js`), jamais
// persisté ni journalisé, sans texte ni `raw`. Une vue ANCIENNE sans génération peut
// servir une page UNIQUE sans curseur, mais refuse d'émettre un curseur
// (`view_unavailable`/`invalid_schema`) : reconstruction CLI manuelle requise.
import { openReadSnapshot } from './data.js'
import { resolveReadWindowDb, pageKeys, NON_TITLE, DEFAULT_READ_CTX } from '../read.js'
import { measureSerialized } from './budget.js'
import {
  RESPONSE_BUDGET_BYTES,
  MAX_ID_STRING_CHARS,
  MAX_READ_MESSAGES,
  MAX_READ_CHARS,
  READ_OFFSET_UNIT,
  READ_TEXT_ENCODING
} from './constants.js'
import { unknownSession, invalidAnchor, invalidCursor, staleCursor, viewUnavailable, internalError } from './errors.js'
import { piFidelityNotice } from '../format.js'
import { fmtTs } from '../util.js'
import { CursorStore, CURSOR_TOKEN_BYTES } from './cursor.js'

// Défaut de fragment : 400 points de code (défaut d'affichage CLI). `full` monte au
// plafond (20 000) ; `chars` explicite est borné par le plafond (validate.js).
const DEFAULT_READ_CHARS = 400
const ENVELOPE_ID = 'x'.repeat(MAX_ID_STRING_CHARS)
// Curseur FACTICE de la longueur RÉELLE d'un jeton (256 bits hex) : la sonde de
// budget mesure l'enveloppe EXACTE (curseur + dimensions réelles), sans marge
// arbitraire qui refuserait un élément minimal pourtant admissible.
const FAKE_CURSOR = '0'.repeat(CURSOR_TOKEN_BYTES * 2)

// Textes d'erreur FIXES (jamais d'écho de l'entrée : ni session, ni aroundId, ni date).
const EMPTY_TEXT = 'aucun message dans la vue choisie (ancre incluse)'
const MASKED_TEXT = 'fenêtre entièrement postérieure à l\'ancre — message masqué'
const AROUND_UNKNOWN_TEXT = 'message demandé introuvable — vue complète affichée'

function envelopeBytes (output) {
  return measureSerialized({ jsonrpc: '2.0', id: ENVELOPE_ID, result: { content: [], structuredContent: output } })
}

const sameKey = (a, b) => a.ts === b.ts && a.id === b.id
const codePointLen = (s) => [...s].length

function parseModel (col) {
  if (col == null || col === '') return null
  const i = col.indexOf('/')
  const providerID = i >= 0 ? col.slice(0, i) : null
  const modelID = i >= 0 ? col.slice(i + 1) : col
  const m = {}
  if (providerID) m.providerID = providerID
  if (modelID) m.modelID = modelID
  return Object.keys(m).length ? m : null
}

function parseToolCalls (raw) {
  if (raw == null) return []
  let arr
  try { arr = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr.map((c) => {
    const out = {}
    if (c && c.tool != null) out.tool = String(c.tool)
    if (c && c.cmd != null) out.cmd = String(c.cmd)
    if (Number.isInteger(c && c.exitCode)) out.exitCode = c.exitCode
    if (c && c.rawRef != null) out.rawRef = String(c.rawRef)
    return out
  })
}

// Projection SQL BORNÉE (voie normale) : métadonnées + `substr(e.text, …)` (jamais
// `SELECT json`), AUCUN BLOB complet. `nulPos` détecte le cas rare d'un U+0000.
const FRAGMENT_SQL = `SELECT e.id, e.ts, e.role, e.agent, e.model,
    length(e.text) AS charLen,
    instr(CAST(e.text AS BLOB), x'00') AS nulPos,
    substr(e.text, @off + 1, @chars) AS frag,
    json_extract(e.json, '$.toolCalls') AS toolCalls
  FROM events e
  WHERE e.id = @id AND e.session_id = @sid AND ${NON_TITLE}`

// Repli U+0000 : on ne transfère qu'un CHUNK BLOB borné (`≈ 4*chars + 4` octets)
// depuis un `byteOffset` de continuation — jamais le message entier.
const NUL_CHUNK_SQL = `SELECT length(CAST(e.text AS BLOB)) AS byteLenTotal,
    substr(CAST(e.text AS BLOB), @byteOff + 1, @chunkBytes) AS chunk
  FROM events e
  WHERE e.id = @id AND e.session_id = @sid AND ${NON_TITLE}`

/** Longueur des octets UTF-8 COMPLETS d'un buffer (coupe une séquence partielle). */
function utf8CompleteBytes (buf) {
  const n = buf.length
  let back = 0
  while (back < 4 && back < n) {
    const b = buf[n - 1 - back]
    if ((b & 0xC0) !== 0x80) {
      const need = b < 0x80 ? 1 : (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : (b & 0xF8) === 0xF0 ? 4 : 1
      return back + 1 >= need ? n : n - 1 - back
    }
    back++
  }
  return n - back
}

/**
 * Fragment d'un message à `offset` (points de code) et `byteOffset` (octets, repli
 * NUL), ≤ `chars` points. Retourne `{ entry, fullLen, byteOffset }` (`fullLen` peut
 * être `null` pour un message NUL : total inconnu, jamais inventé ; `byteOffset` est
 * la position de continuation exacte, `null` hors repli). `null` si absent.
 */
function fetchFragment (view, sessionId, key, offset, byteOffset, chars, index) {
  const row = view.get(FRAGMENT_SQL, { id: key.id, sid: sessionId, off: offset, chars })
  if (!row) return null
  const base = { id: row.id, ts: row.ts, date: fmtTs(row.ts), role: row.role, agent: row.agent ?? null, model: parseModel(row.model), toolCalls: parseToolCalls(row.toolCalls) }
  if (row.nulPos === 0) {
    const text = row.frag ?? ''
    const end = offset + codePointLen(text)
    const fullLen = row.charLen ?? 0
    return { entry: { index, ...base, text, offset, end, complete: end >= fullLen }, fullLen, byteOffset: null }
  }
  // Repli NUL : chunk BLOB borné, décodage UTF-8 sans « replacement ».
  const chunkBytes = 4 * chars + 4
  const nrow = view.get(NUL_CHUNK_SQL, { id: key.id, sid: sessionId, byteOff: byteOffset ?? 0, chunkBytes })
  const buf = nrow && nrow.chunk ? nrow.chunk : Buffer.alloc(0)
  const str = buf.subarray(0, utf8CompleteBytes(buf)).toString('utf8')
  const text = [...str].slice(0, chars).join('')
  const nextByteOffset = (byteOffset ?? 0) + Buffer.byteLength(text, 'utf8')
  const complete = nextByteOffset >= (nrow ? (nrow.byteLenTotal ?? 0) : 0)
  const end = offset + codePointLen(text)
  return { entry: { index, ...base, text, offset, end, complete }, fullLen: null, byteOffset: nextByteOffset }
}

function effectiveChars (input) {
  if (input.full === true) return MAX_READ_CHARS
  if (Number.isInteger(input.chars) && input.chars >= 1) return Math.min(input.chars, MAX_READ_CHARS)
  return DEFAULT_READ_CHARS
}

const effectiveCtx = (input) => (Number.isInteger(input.ctx) && input.ctx >= 0 ? input.ctx : DEFAULT_READ_CTX)

function fidelityFor (ses) {
  return ses && ses.source === 'pi' ? piFidelityNotice() : undefined
}

function buildOutput ({ w, freshness, messages, adaptations, nextCursor, dims = [], error = null }) {
  const out = {
    sessionId: w.ses.id,
    title: w.ses.title ?? null,
    repo: w.ses.repo ?? null,
    anchor: w.anchor,
    maskedCount: w.maskedCount,
    visible: w.visible,
    total: w.total,
    messages,
    adaptations,
    // Unités EXPLICITES : offsets en points de code Unicode, `end` EXCLU, texte UTF-8.
    offsetUnit: READ_OFFSET_UNIT,
    encoding: READ_TEXT_ENCODING,
    freshness
  }
  if (error) out.error = error
  const fidelity = fidelityFor(w.ses)
  if (fidelity) out.fidelity = fidelity
  if (nextCursor || dims.length) {
    const truncated = { dimensions: dims }
    if (nextCursor) truncated.nextCursor = nextCursor
    out.truncated = truncated
  }
  return out
}

/**
 * Clés de la page (≤ maxMessages) : fenêtre bornée (around/tail) ou keyset (all).
 * `knownTotal` est EXACT quand il est connu : longueur de fenêtre (around/tail) ou
 * `w.visible` (all). Une position `inclusive` (arrêt budget ou message partiel)
 * réinclut la clé MÊME à offset 0. Une position de fenêtre INTROUVABLE (around/tail)
 * ne repart PAS silencieusement à 0 : `invalidPosition` (curseur conservateur).
 */
function candidateKeys (view, sessionId, w, startPosition, maxMessages, anchorTs) {
  if (w.mode === 'around' || w.mode === 'tail') {
    const windowKeys = w.keys
    let from = 0
    if (startPosition) {
      const idx = windowKeys.findIndex((k) => sameKey(k, startPosition.key))
      if (idx < 0) return { invalidPosition: true }
      from = startPosition.inclusive ? idx : idx + 1
    }
    const keys = windowKeys.slice(from, from + maxMessages)
    return { keys, hasMore: from + maxMessages < windowKeys.length, knownTotal: windowKeys.length }
  }
  const keys = []
  if (startPosition && startPosition.inclusive) keys.push(startPosition.key)
  const remaining = Math.max(0, maxMessages - keys.length)
  const after = startPosition ? startPosition.key : null
  const page = remaining > 0 ? pageKeys(view, sessionId, { after, limit: remaining, anchorTs }) : { keys: [], hasMore: true }
  keys.push(...page.keys)
  return { keys, hasMore: page.hasMore, knownTotal: w.visible }
}

function finishRead ({ ctx, w, sessionId, windowParams, startPosition, adaptations, cursors, error }) {
  if (w.mode === 'empty' || w.mode === 'around-masked') {
    const out = buildOutput({ w, freshness: ctx.freshness, messages: [], adaptations, error: error ?? (w.mode === 'empty' ? EMPTY_TEXT : MASKED_TEXT) })
    // Métadonnée (titre/repo) seule hors budget ⇒ erreur bornée, jamais de dépassement.
    if (envelopeBytes(out) > RESPONSE_BUDGET_BYTES) throw internalError('budget_exhausted')
    return out
  }

  const anchorTs = w.mode === 'all' ? (w.anchor ? w.anchor.ts : null) : null
  const ck = candidateKeys(ctx.view, sessionId, w, startPosition, MAX_READ_MESSAGES, anchorTs)
  if (ck.invalidPosition) throw invalidCursor()
  const { keys, hasMore, knownTotal } = ck
  const startIndex = w.spans.length ? w.spans[0][0] : 0

  // Sonde EXACTE : curseur factice de longueur réelle + dimensions RÉELLES du
  // candidat. Aucune marge arbitraire ; une dernière page sans curseur ne réserve rien.
  const fits = (entries, fullLens, cursorNeeded) => {
    const dims = []
    if (cursorNeeded) dims.push({ dimension: 'messages', retained: entries.length, total: knownTotal })
    if (entries.some((m) => !m.complete)) {
      const retained = entries.reduce((n, m) => n + codePointLen(m.text), 0)
      const known = fullLens.every((x) => x != null)
      dims.push({ dimension: 'text', retained, total: known ? fullLens.reduce((n, x) => n + x, 0) : null })
    }
    const probe = buildOutput({ w, freshness: ctx.freshness, messages: entries, adaptations, nextCursor: cursorNeeded ? FAKE_CURSOR : null, dims, error })
    return envelopeBytes(probe) <= RESPONSE_BUDGET_BYTES
  }

  const messages = []
  const fullLens = []
  let nextPosition = null
  let index = startPosition ? startPosition.index : startIndex
  let i = 0
  for (; i < keys.length; i++) {
    const key = keys[i]
    const isStart = i === 0 && startPosition && startPosition.inclusive && sameKey(key, startPosition.key)
    const offset = isStart ? startPosition.offset : 0
    const byteOffset = isStart ? (startPosition.byteOffset ?? 0) : 0
    const isLastKey = i === keys.length - 1
    const frag = pickFragment(ctx.view, sessionId, key, offset, byteOffset, index, windowParams.chars, isLastKey, hasMore, messages, fullLens, fits)
    if (frag === null) { index++; continue }
    if (frag === 'no-fit') {
      // Représentation MINIMALE (métadonnée + fragment réduit au minimum) hors budget.
      if (messages.length === 0) throw internalError('budget_exhausted')
      nextPosition = { key: { ts: key.ts, id: key.id }, offset, inclusive: true, index, byteOffset: isStart ? (startPosition.byteOffset ?? null) : null }
      break
    }
    messages.push(frag.entry)
    fullLens.push(frag.fullLen)
    if (!frag.entry.complete) {
      nextPosition = { key: { ts: key.ts, id: key.id }, offset: frag.entry.end, inclusive: true, index, byteOffset: frag.byteOffset }
      break
    }
    index++
  }
  if (nextPosition == null && i >= keys.length && hasMore) {
    const lastKey = keys[keys.length - 1]
    nextPosition = { key: { ts: lastKey.ts, id: lastKey.id }, offset: 0, inclusive: false, index, byteOffset: null }
  }

  const dims = []
  if (nextPosition != null) dims.push({ dimension: 'messages', retained: messages.length, total: knownTotal })
  if (messages.some((m) => !m.complete)) {
    const known = fullLens.every((x) => x != null)
    dims.push({ dimension: 'text', retained: messages.reduce((n, m) => n + codePointLen(m.text), 0), total: known ? fullLens.reduce((n, x) => n + x, 0) : null })
  }

  let nextCursor = null
  if (nextPosition != null) {
    // Vue ancienne SANS génération : une page unique peut réussir, mais on n'émet
    // JAMAIS un curseur dont l'identité de génération ne peut être établie.
    if (ctx.generation == null) throw viewUnavailable('invalid_schema')
    nextCursor = cursors.create({
      v: 1,
      session: sessionId,
      around: windowParams.around,
      ctx: windowParams.ctx,
      tail: windowParams.tail,
      at: windowParams.at,
      full: windowParams.full,
      chars: windowParams.chars,
      adaptations,
      generation: ctx.generation,
      readIdentity: ctx.readIdentity,
      position: nextPosition
    })
  }
  return buildOutput({ w, freshness: ctx.freshness, messages, adaptations, nextCursor, dims, error })
}

/**
 * Fragment retenu pour une clé : complet si possible, sinon RÉDUIT par recherche
 * binaire de `chars` (re-fetch SQL). `null` = message absent ; `'no-fit'` = même la
 * représentation minimale (1 point, ou vide pour un message vide) ne tient pas.
 * La borne basse de recherche vaut 1 pour un message NON VIDE (0 ne progresserait
 * pas) et 0 pour un message vide — sans jamais manquer la frontière 1 point.
 */
function pickFragment (view, sessionId, key, offset, byteOffset, index, requestedChars, isLastKey, hasMore, messages, fullLens, fits) {
  const full = fetchFragment(view, sessionId, key, offset, byteOffset, requestedChars, index)
  if (!full) return null
  const cursorFull = !(isLastKey && full.entry.complete && !hasMore)
  if (fits(messages.concat([full.entry]), fullLens.concat([full.fullLen]), cursorFull)) return full
  const shownLen = codePointLen(full.entry.text)
  const minChars = (full.entry.complete && shownLen === 0) ? 0 : 1
  // Fragments PARTIELS uniquement (une version complète a déjà été testée) → `fits`
  // avec suite garantie, ensemble faisable MONOTONE.
  const upper = full.entry.complete ? shownLen - 1 : requestedChars
  let lo = minChars
  let hi = upper
  let best = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const frag = mid === requestedChars ? full : fetchFragment(view, sessionId, key, offset, byteOffset, mid, index)
    if (!frag) { hi = mid - 1; continue }
    const progresses = codePointLen(frag.entry.text) >= 1 || frag.entry.complete
    if (progresses && fits(messages.concat([frag.entry]), fullLens.concat([frag.fullLen]), true)) { best = frag; lo = mid + 1 } else { hi = mid - 1 }
  }
  return best ?? 'no-fit'
}

function startRead (ctx, input, adaptations, cursors) {
  const sessionId = input.session
  const chars = effectiveChars(input)
  const windowParams = { around: input.around ?? null, ctx: effectiveCtx(input), tail: input.tail ?? null, at: input.at ?? null, full: input.full === true, chars }
  const w = resolveReadWindowDb(ctx.view, sessionId, { aroundId: windowParams.around, ctx: windowParams.ctx, tail: windowParams.tail, at: windowParams.at })
  if (w === null) throw unknownSession()
  if (w.fatal) throw invalidAnchor()
  const error = w.mode === 'all' && w.warning ? AROUND_UNKNOWN_TEXT : null
  return finishRead({ ctx, w, sessionId, windowParams, startPosition: null, adaptations, cursors, error })
}

function resumeRead (ctx, token, cursors) {
  const state = cursors.get(token)
  if (!state) throw invalidCursor()
  // Changement de génération/watermarks depuis l'émission : suite refusée.
  if (state.generation !== ctx.generation || state.readIdentity !== ctx.readIdentity) throw staleCursor()
  const w = resolveReadWindowDb(ctx.view, state.session, { aroundId: state.around, ctx: state.ctx ?? DEFAULT_READ_CTX, tail: state.tail, at: state.at })
  if (w === null) throw unknownSession()
  if (w.fatal) throw invalidAnchor()
  const error = w.mode === 'all' && w.warning ? AROUND_UNKNOWN_TEXT : null
  return finishRead({ ctx, w, sessionId: state.session, windowParams: { ...state }, startPosition: state.position, adaptations: state.adaptations ?? [], cursors, error })
}

/**
 * Fabrique le handler `sdig_read`. `config` = configuration propriétaire
 * `{ root, sources }`. Le curseur vit dans un cache process-local borné, purgé par
 * `handler.dispose()` (arrêt normal) ; aucune persistance, aucun journal.
 */
export function createReadHandler (config, { cursors = new CursorStore() } = {}) {
  const handler = function sdigRead (value, adaptations) {
    const input = value ?? {}
    const extra = Array.isArray(adaptations) ? adaptations : []
    return openReadSnapshot(config, (ctx) => {
      if (input.cursor !== undefined) return resumeRead(ctx, input.cursor, cursors)
      return startRead(ctx, input, extra, cursors)
    }).data
  }
  handler.dispose = () => cursors.clear()
  handler.clearCursors = () => cursors.clear()
  handler.cursors = cursors
  return handler
}

export { DEFAULT_READ_CHARS }
