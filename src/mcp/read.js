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

/** Métadonnées BORNÉES d'un appel : jamais le `cmd` entier (extrait par fragments). */
function callMetaFields (call) {
  const out = { callIndex: call.callIndex }
  if (call.tool !== undefined) out.tool = call.tool
  if (call.exitCode !== undefined) out.exitCode = call.exitCode
  if (call.rawRef !== undefined) out.rawRef = call.rawRef
  return out
}

/** Points de code de commandes EFFECTIVEMENT rendus dans une entrée de message. */
function emittedCmdPoints (entry) {
  let n = 0
  for (const c of entry.toolCalls || []) if (c.cmd != null) n += codePointLen(c.cmd)
  for (const f of entry.toolCallFragments || []) if (f.cmd != null) n += codePointLen(f.cmd)
  return n
}

/**
 * Entrée de message : `complete` n'est VRAI que si le texte ET TOUS les appels
 * sont complets. Les champs `textComplete`/`toolCallsComplete` ne sont ajoutés que
 * pour un message PORTANT des appels (champs additifs, contrat inchangé sinon).
 * Chaque champ décrit SA composante ; `complete` est leur conjonction.
 */
function makeMessageEntry (base, { hasCalls, textComplete, toolCalls, fragments, callsDone }) {
  const entry = { ...base, toolCalls }
  if (fragments && fragments.length) entry.toolCallFragments = fragments
  if (hasCalls) {
    entry.textComplete = textComplete === true
    entry.toolCallsComplete = callsDone === true
    entry.complete = textComplete === true && callsDone === true
  } else {
    entry.complete = textComplete === true
  }
  return entry
}

// Projection SQL BORNÉE du texte (jamais `SELECT json`), AUCUN BLOB complet.
// `nulPos` détecte le cas rare d'un U+0000 ; le repli BLOB reste borné.
const FRAGMENT_SQL = `SELECT e.id, e.ts, e.role, e.agent, e.model,
    length(e.text) AS charLen,
    instr(CAST(e.text AS BLOB), x'00') AS nulPos,
    substr(e.text, @off + 1, @chars) AS frag
  FROM events e
  WHERE e.id = @id AND e.session_id = @sid AND ${NON_TITLE}`

// Métadonnées d'appel : UN LOT de ≤ `CALL_META_BATCH` lignes, curseur par
// `callIndex` GLOBAL (`j.key >= @from`), `LIMIT` explicite. Le tableau `$.toolCalls`
// n'est JAMAIS transféré entier ; `cmd` n'apparaît que par fragments ailleurs.
// HONNÊTETÉ : `tool`/`rawRef` ne sont PAS bornés en longueur par cette requête ;
// un préflight agrégé (`CALLS_SUMMARY_SQL`) refuse AVANT transfert une chaîne dont
// la longueur en OCTETS dépasse à elle seule le budget total (représentation
// minimale impossible). Le seuil est en octets via `CAST(... AS BLOB)` : `length`
// TEXT s'arrêterait au premier U+0000 et sous-estimerait l'UTF-8 multioctet.
const CALLS_META_SQL = `SELECT j.key AS callIndex,
    json_extract(j.value, '$.tool') AS tool,
    json_extract(j.value, '$.exitCode') AS exitCode,
    json_extract(j.value, '$.rawRef') AS rawRef,
    length(json_extract(j.value, '$.cmd')) AS cmdLen,
    instr(CAST(json_extract(j.value, '$.cmd') AS BLOB), x'00') AS nulPos,
    length(CAST(json_extract(j.value, '$.cmd') AS BLOB)) AS cmdByteLen
  FROM events e, json_each(e.json, '$.toolCalls') j
  WHERE e.id = @id AND e.session_id = @sid AND ${NON_TITLE}
    AND json_type(e.json, '$.toolCalls') = 'array'
    AND j.key >= @from
  ORDER BY j.key
  LIMIT @limit`

// Agrégat BORNÉ (une ligne) : nombre d'appels, longueur cumulée de `cmd` en points
// (`null`/faussée si U+0000) et longueurs MAXIMALES en OCTETS de `tool`/`rawRef`
// (`CAST(... AS BLOB)`) pour le préflight. Aucun membre d'appel n'est transféré ici.
const CALLS_SUMMARY_SQL = `SELECT
    COUNT(*) AS callCount,
    MAX(CASE WHEN instr(CAST(json_extract(j.value, '$.cmd') AS BLOB), x'00') > 0 THEN 1 ELSE 0 END) AS anyNul,
    SUM(length(json_extract(j.value, '$.cmd'))) AS cmdTotalLen,
    MAX(length(CAST(json_extract(j.value, '$.tool') AS BLOB))) AS maxToolBytes,
    MAX(length(CAST(json_extract(j.value, '$.rawRef') AS BLOB))) AS maxRawRefBytes
  FROM events e, json_each(e.json, '$.toolCalls') j
  WHERE e.id = @id AND e.session_id = @sid AND ${NON_TITLE}
    AND json_type(e.json, '$.toolCalls') = 'array'`

/** Taille du lot de métadonnées d'appels (borne JS par lecture, indépendante du total). */
const CALL_META_BATCH = 200

const cmdPath = (i) => `'$."toolCalls"[${i}].cmd'`

// Fragment de commande borné (points de code) : `substr` SQL, jamais le cmd entier.
const CMD_FRAG_SQL = (i) => `SELECT substr(json_extract(e.json, ${cmdPath(i)}), @off + 1, @chars) AS frag,
    length(json_extract(e.json, ${cmdPath(i)})) AS cmdLen
  FROM events e
  WHERE e.id = @id AND e.session_id = @sid AND ${NON_TITLE}`

// Repli U+0000 d'une commande : chunk BLOB borné, jamais le cmd entier.
const CMD_CHUNK_SQL = (i) => `SELECT substr(CAST(json_extract(e.json, ${cmdPath(i)}) AS BLOB), @byteOff + 1, @chunkBytes) AS chunk,
    length(CAST(json_extract(e.json, ${cmdPath(i)}) AS BLOB)) AS byteLenTotal
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
 * Fragment de TEXTE d'un message à `offset` (points de code) et `byteOffset`
 * (octets, repli NUL), ≤ `chars` points. Retourne `{ base, text, offset, end,
 * textComplete, fullLen, byteOffset }` (`fullLen` peut être `null` pour un message
 * NUL : total inconnu, jamais inventé). `null` si le message est absent.
 */
function fetchTextFragment (view, sessionId, key, offset, byteOffset, chars) {
  const row = view.get(FRAGMENT_SQL, { id: key.id, sid: sessionId, off: offset, chars })
  if (!row) return null
  const base = { id: row.id, ts: row.ts, date: fmtTs(row.ts), role: row.role, agent: row.agent ?? null, model: parseModel(row.model) }
  if (row.nulPos === 0) {
    const text = row.frag ?? ''
    const end = offset + codePointLen(text)
    const fullLen = row.charLen ?? 0
    return { base, text, offset, end, textComplete: end >= fullLen, fullLen, byteOffset: null }
  }
  // Repli NUL : chunk BLOB borné, décodage UTF-8 sans « replacement ».
  const chunkBytes = 4 * chars + 4
  const nrow = view.get(NUL_CHUNK_SQL, { id: key.id, sid: sessionId, byteOff: byteOffset ?? 0, chunkBytes })
  const buf = nrow && nrow.chunk ? nrow.chunk : Buffer.alloc(0)
  const str = buf.subarray(0, utf8CompleteBytes(buf)).toString('utf8')
  const text = [...str].slice(0, chars).join('')
  const nextByteOffset = (byteOffset ?? 0) + Buffer.byteLength(text, 'utf8')
  const textComplete = nextByteOffset >= (nrow ? (nrow.byteLenTotal ?? 0) : 0)
  return { base, text, offset, end: offset + codePointLen(text), textComplete, fullLen: null, byteOffset: nextByteOffset }
}

/** Ligne SQL de métadonnées → appel borné. `hasCmd` distingue l'absence de
 * commande d'une commande vide ; `hasNul` signale le repli BLOB (longueur en points
 * alors inconnue, `cmdLen: null`). */
function toCallMeta (r) {
  const callIndex = Number.isSafeInteger(r.callIndex) ? r.callIndex : null
  const hasCmd = r.cmdByteLen != null
  const hasNul = r.nulPos != null && r.nulPos > 0
  return {
    callIndex,
    tool: r.tool != null ? String(r.tool) : undefined,
    exitCode: Number.isInteger(r.exitCode) ? r.exitCode : undefined,
    rawRef: r.rawRef != null ? String(r.rawRef) : undefined,
    hasCmd,
    hasNul,
    cmdLen: hasCmd && !hasNul && Number.isInteger(r.cmdLen) ? r.cmdLen : null,
    cmdByteLen: hasCmd ? r.cmdByteLen : null
  }
}

/**
 * Agrégat BORNÉ (une ligne) des appels d'un message : nombre et longueur cumulée
 * de `cmd` (points ; `null` si U+0000 fausse la mesure), et longueurs MAXIMALES en
 * OCTETS de `tool`/`rawRef` pour le préflight. Aucun membre transféré.
 */
function fetchCallsSummary (view, sessionId, key) {
  const row = view.get(CALLS_SUMMARY_SQL, { id: key.id, sid: sessionId })
  return {
    callCount: row && Number.isInteger(row.callCount) ? row.callCount : 0,
    anyNul: !!(row && row.anyNul),
    cmdTotalLen: row && Number.isInteger(row.cmdTotalLen) ? row.cmdTotalLen : null,
    maxToolBytes: row && Number.isInteger(row.maxToolBytes) ? row.maxToolBytes : null,
    maxRawRefBytes: row && Number.isInteger(row.maxRawRefBytes) ? row.maxRawRefBytes : null
  }
}

/**
 * Source de métadonnées d'appels chargée par LOTS SQL bornés : au plus
 * `CALL_META_BATCH` entrées en JS à la fois, quel que soit le nombre d'appels.
 * L'accès est séquentiel (avance) ; un retour arrière relit un lot.
 */
function createCallSource (view, sessionId, key, callCount) {
  let start = -1
  let batch = []
  return {
    count: callCount,
    get (i) {
      if (i < start || i >= start + batch.length) {
        start = i
        batch = view.all(CALLS_META_SQL, { id: key.id, sid: sessionId, from: i, limit: CALL_META_BATCH }).map(toCallMeta)
      }
      return batch[i - start] ?? null
    }
  }
}

/**
 * Fragment d'une commande d'appel à `cmdOffset` (points) et `cmdByteOffset`
 * (octets, repli NUL), ≤ `chars` points. `null` si l'appel est absent. Un appel
 * sans commande est `complete` sans contenu.
 */
function fetchCallFragment (view, sessionId, key, call, cmdOffset, cmdByteOffset, chars) {
  if (!call.hasCmd) return { hasCmd: false, cmd: null, offset: 0, end: 0, complete: true, cmdByteOffset: null }
  if (!call.hasNul) {
    const row = view.get(CMD_FRAG_SQL(call.callIndex), { id: key.id, sid: sessionId, off: cmdOffset, chars })
    if (!row) return null
    const cmd = row.frag ?? ''
    const end = cmdOffset + codePointLen(cmd)
    const fullLen = row.cmdLen ?? 0
    return { hasCmd: true, cmd, offset: cmdOffset, end, complete: end >= fullLen, cmdByteOffset: null }
  }
  const chunkBytes = 4 * chars + 4
  const nrow = view.get(CMD_CHUNK_SQL(call.callIndex), { id: key.id, sid: sessionId, byteOff: cmdByteOffset ?? 0, chunkBytes })
  const buf = nrow && nrow.chunk ? nrow.chunk : Buffer.alloc(0)
  const str = buf.subarray(0, utf8CompleteBytes(buf)).toString('utf8')
  const cmd = [...str].slice(0, chars).join('')
  const nextByteOffset = (cmdByteOffset ?? 0) + Buffer.byteLength(cmd, 'utf8')
  const complete = nextByteOffset >= (nrow ? (nrow.byteLenTotal ?? 0) : 0)
  return { hasCmd: true, cmd, offset: cmdOffset, end: cmdOffset + codePointLen(cmd), complete, cmdByteOffset: nextByteOffset }
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

/** Dimensions de troncature, cohérentes avec la sonde de budget (par dimension). */
function computeDims (entries, metas, knownTotal, cursorNeeded) {
  const dims = []
  if (cursorNeeded) dims.push({ dimension: 'messages', retained: entries.length, total: knownTotal })
  if (entries.some((m) => (m.textComplete ?? m.complete) === false)) {
    const known = metas.every((x) => x.textFull != null)
    dims.push({ dimension: 'text', retained: entries.reduce((n, m) => n + codePointLen(m.text), 0), total: known ? metas.reduce((n, x) => n + x.textFull, 0) : null })
  }
  if (entries.some((m) => m.toolCallsComplete === false)) {
    const known = metas.every((x) => x.cmdFull != null)
    dims.push({ dimension: 'toolCalls', retained: entries.reduce((n, m) => n + emittedCmdPoints(m), 0), total: known ? metas.reduce((n, x) => n + x.cmdFull, 0) : null })
  }
  return dims
}

/**
 * Fragment de TEXTE retenu pour une clé : complet si possible, sinon RÉDUIT par
 * recherche binaire de `chars` (re-fetch SQL). `null` = message absent ;
 * `'no-fit'` = même la représentation minimale ne tient pas. Les COMMANDES ne sont
 * pas rendues tant que le texte n'est pas complet (aucune commande coupée présentée
 * comme entière) : la phase commandes suit, curseur en main.
 */
function pickTextFragment ({ view, sessionId, key, index, offset, byteOffset, requestedChars, isLastKey, hasMore, messages, metas, fits, hasCalls, cmdFull }) {
  const full = fetchTextFragment(view, sessionId, key, offset, byteOffset, requestedChars)
  if (!full) return null
  const base = (frag) => ({ index, ...frag.base, text: frag.text, offset: frag.offset, end: frag.end })
  const entryOf = (frag) => makeMessageEntry(base(frag), { hasCalls, textComplete: frag.textComplete, toolCalls: [], fragments: [], callsDone: false })
  const metaOf = (frag) => ({ textFull: frag.fullLen, cmdFull })

  const fullEntry = entryOf(full)
  const cursorFull = !(isLastKey && fullEntry.complete === true && !hasMore)
  if (fits(messages.concat([fullEntry]), metas.concat([metaOf(full)]), cursorFull)) {
    return { entry: fullEntry, base: base(full), end: full.end, byteOffset: full.byteOffset, textFull: full.fullLen, textComplete: full.textComplete }
  }
  const shownLen = codePointLen(full.text)
  const minChars = (full.textComplete && shownLen === 0) ? 0 : 1
  const upper = shownLen - 1
  let lo = minChars
  let hi = upper
  let best = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const frag = mid === requestedChars ? full : fetchTextFragment(view, sessionId, key, offset, byteOffset, mid)
    if (!frag) { hi = mid - 1; continue }
    const progresses = codePointLen(frag.text) >= 1 || frag.textComplete
    // Fragments PARTIELS uniquement → suite garantie, ensemble faisable MONOTONE.
    if (progresses && fits(messages.concat([entryOf(frag)]), metas.concat([metaOf(frag)]), true)) { best = frag; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (!best) return 'no-fit'
  return { entry: entryOf(best), base: base(best), end: best.end, byteOffset: best.byteOffset, textFull: best.fullLen, textComplete: best.textComplete }
}

/**
 * Phase COMMANDES d'un message au texte complet : rend les appels dans l'ordre,
 * chaque `cmd` par fragment borné (SQL), jusqu'à épuisement du budget. Un appel
 * entièrement rendu depuis son début reste dans `toolCalls` (forme nominale) ; un
 * appel coupé ou repris va dans `toolCallFragments` avec `offset`/`end`/`complete`.
 * `done` = tous les appels rendus ; sinon `next` = position de reprise exacte.
 * `progress` = au moins un élément a été rendu sur CETTE page.
 */
function fillCalls ({ view, sessionId, key, base, calls, cmdFull, textFull, startCallIndex, startCmdOffset, startCmdByteOffset, chars, isLastKey, hasMore, messages, metas, fits }) {
  const toolCalls = []
  const fragments = []
  let callIndex = startCallIndex
  let cmdOffset = startCmdOffset
  let cmdByteOffset = startCmdByteOffset

  const metaOf = { textFull, cmdFull }
  const build = (callsDone) => makeMessageEntry(base, { hasCalls: true, textComplete: true, toolCalls, fragments, callsDone })
  const fitsEntry = (callsDone) => {
    const entry = build(callsDone)
    const cursorNeeded = !(isLastKey && entry.complete === true && !hasMore)
    return { entry, ok: fits(messages.concat([entry]), metas.concat([metaOf]), cursorNeeded) }
  }
  const stop = () => ({ entry: build(false), done: false, progress: codePointLen(base.text) >= 1 || toolCalls.length > 0 || fragments.length > 0, next: { callIndex, cmdOffset, cmdByteOffset } })

  while (callIndex < calls.count) {
    const call = calls.get(callIndex)
    if (!call) return stop()
    const fragEntry = (frag) => ({ ...callMetaFields(call), cmd: frag.cmd, offset: frag.offset, end: frag.end, complete: frag.complete })
    if (!call.hasCmd) {
      toolCalls.push(callMetaFields(call))
      if (fitsEntry(callIndex + 1 === calls.count).ok) { callIndex++; cmdOffset = 0; cmdByteOffset = null; continue }
      toolCalls.pop()
      return stop()
    }
    const frag = fetchCallFragment(view, sessionId, key, call, cmdOffset, cmdByteOffset, chars)
    if (!frag) return stop()
    // Appel entier depuis son début : forme nominale dans `toolCalls`.
    if (cmdOffset === 0 && frag.complete) {
      toolCalls.push({ ...callMetaFields(call), cmd: frag.cmd })
      if (fitsEntry(callIndex + 1 === calls.count).ok) { callIndex++; cmdOffset = 0; cmdByteOffset = null; continue }
      toolCalls.pop()
    }
    // Fragment (appel repris, ou commande non terminée) : `toolCallFragments`.
    fragments.push(fragEntry(frag))
    if (fitsEntry(frag.complete && callIndex + 1 === calls.count).ok) {
      if (!frag.complete) { const s = stop(); s.next = { callIndex, cmdOffset: frag.end, cmdByteOffset: frag.cmdByteOffset }; return s }
      if (callIndex + 1 === calls.count) return { entry: build(true), done: true, progress: true }
      callIndex++; cmdOffset = 0; cmdByteOffset = null
      continue
    }
    fragments.pop()
    // Recherche binaire d'un fragment PLUS PETIT qui tienne (jamais 0 point).
    const maxLen = codePointLen(frag.cmd)
    let lo = 1
    let hi = maxLen - 1
    let best = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const cand = mid === maxLen ? frag : fetchCallFragment(view, sessionId, key, call, cmdOffset, cmdByteOffset, mid)
      if (!cand) { hi = mid - 1; continue }
      if (codePointLen(cand.cmd) < 1 && !cand.complete) { hi = mid - 1; continue }
      fragments.push(fragEntry(cand))
      const ok = fitsEntry(false).ok
      fragments.pop()
      if (ok) { best = cand; lo = mid + 1 } else { hi = mid - 1 }
    }
    if (!best) return stop()
    fragments.push(fragEntry(best))
    if (best.complete && callIndex + 1 === calls.count) return { entry: build(true), done: true, progress: true }
    const s = stop()
    if (best.complete) { callIndex++; cmdOffset = 0; cmdByteOffset = null } else { cmdOffset = best.end; cmdByteOffset = best.cmdByteOffset }
    s.next = { callIndex, cmdOffset, cmdByteOffset }
    return s
  }
  return { entry: build(true), done: true, progress: true }
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
  // candidat. Borne PAR PAGE : somme des points de texte + commandes de TOUTES les
  // entrées ≤ `MAX_READ_CHARS` (plafond de conception, jamais augmenté).
  const fits = (entries, metas, cursorNeeded) => {
    let points = 0
    for (const m of entries) points += codePointLen(m.text) + emittedCmdPoints(m)
    if (points > MAX_READ_CHARS) return false
    const dims = computeDims(entries, metas, knownTotal, cursorNeeded)
    const probe = buildOutput({ w, freshness: ctx.freshness, messages: entries, adaptations, nextCursor: cursorNeeded ? FAKE_CURSOR : null, dims, error })
    return envelopeBytes(probe) <= RESPONSE_BUDGET_BYTES
  }

  const messages = []
  const metas = []
  let nextPosition = null
  let index = startPosition ? startPosition.index : startIndex
  let i = 0
  for (; i < keys.length; i++) {
    const key = keys[i]
    const isStart = i === 0 && startPosition && startPosition.inclusive && sameKey(key, startPosition.key)
    const offset = isStart ? startPosition.offset : 0
    const byteOffset = isStart ? (startPosition.byteOffset ?? 0) : 0
    const startCallIndex = isStart ? (startPosition.callIndex ?? 0) : 0
    const startCmdOffset = isStart ? (startPosition.cmdOffset ?? 0) : 0
    const startCmdByteOffset = isStart ? (startPosition.cmdByteOffset ?? null) : null
    const isLastKey = i === keys.length - 1

    const summary = fetchCallsSummary(ctx.view, sessionId, key)
    // Préflight AVANT transfert : une métadonnée (`tool`/`rawRef`) dont la longueur
    // en OCTETS dépasse à elle seule le budget total rend toute représentation
    // impossible ⇒ erreur bornée (jamais de transfert d'une chaîne géante).
    if (summary.maxToolBytes > RESPONSE_BUDGET_BYTES || summary.maxRawRefBytes > RESPONSE_BUDGET_BYTES) throw internalError('budget_exhausted')
    const cmdFull = summary.callCount === 0 ? 0 : (summary.anyNul || summary.cmdTotalLen == null ? null : summary.cmdTotalLen)
    const hasCalls = summary.callCount > 0
    const calls = createCallSource(ctx.view, sessionId, key, summary.callCount)

    // Essai du candidat COMPLET (texte entier + tous les appels) avec le VRAI besoin
    // de curseur : un petit message aux petits appels peut tenir SANS curseur alors
    // qu'une sonde réservant une fausse continuation échouerait. Tenté avant toute
    // réduction, sans marge arbitraire ; en cas d'échec, la voie normale réduit.
    if (hasCalls) {
      const fullText = fetchTextFragment(ctx.view, sessionId, key, offset, byteOffset, windowParams.chars)
      if (fullText && fullText.textComplete) {
        const base = { index, ...fullText.base, text: fullText.text, offset: fullText.offset, end: fullText.end }
        const trial = fillCalls({ view: ctx.view, sessionId, key, base, calls, cmdFull, textFull: fullText.fullLen, startCallIndex, startCmdOffset, startCmdByteOffset, chars: windowParams.chars, isLastKey, hasMore, messages, metas, fits })
        if (trial.done) {
          messages.push(trial.entry)
          metas.push({ textFull: fullText.fullLen, cmdFull })
          index++
          continue
        }
      }
    }

    const picked = pickTextFragment({ view: ctx.view, sessionId, key, index, offset, byteOffset, requestedChars: windowParams.chars, isLastKey, hasMore, messages, metas, fits, hasCalls, cmdFull })
    if (picked === null) { index++; continue }
    if (picked === 'no-fit') {
      // Représentation MINIMALE hors budget : erreur bornée si rien ne précède.
      if (messages.length === 0) throw internalError('budget_exhausted')
      nextPosition = { key: { ts: key.ts, id: key.id }, offset, inclusive: true, index, byteOffset: isStart ? (startPosition.byteOffset ?? null) : null, callIndex: startCallIndex, cmdOffset: startCmdOffset, cmdByteOffset: startCmdByteOffset }
      break
    }

    if (picked.textComplete && hasCalls) {
      const res = fillCalls({ view: ctx.view, sessionId, key, base: picked.base, calls, cmdFull, textFull: picked.textFull, startCallIndex, startCmdOffset, startCmdByteOffset, chars: windowParams.chars, isLastKey, hasMore, messages, metas, fits })
      if (!res.done) {
        // Rien rendu sur cette page ET rien avant : aucune page ne progresserait.
        if (!res.progress && messages.length === 0) throw internalError('budget_exhausted')
        if (!res.progress) {
          nextPosition = { key: { ts: key.ts, id: key.id }, offset, inclusive: true, index, byteOffset: isStart ? (startPosition.byteOffset ?? null) : null, callIndex: startCallIndex, cmdOffset: startCmdOffset, cmdByteOffset: startCmdByteOffset }
          break
        }
        messages.push(res.entry)
        metas.push({ textFull: picked.textFull, cmdFull })
        nextPosition = { key: { ts: key.ts, id: key.id }, offset: picked.end, inclusive: true, index, byteOffset: picked.byteOffset, callIndex: res.next.callIndex, cmdOffset: res.next.cmdOffset, cmdByteOffset: res.next.cmdByteOffset }
        break
      }
      messages.push(res.entry)
      metas.push({ textFull: picked.textFull, cmdFull })
      index++
      continue
    }

    messages.push(picked.entry)
    metas.push({ textFull: picked.textFull, cmdFull })
    if (!picked.textComplete) {
      nextPosition = { key: { ts: key.ts, id: key.id }, offset: picked.end, inclusive: true, index, byteOffset: picked.byteOffset, callIndex: startCallIndex, cmdOffset: startCmdOffset, cmdByteOffset: startCmdByteOffset }
      break
    }
    index++
  }
  if (nextPosition == null && i >= keys.length && hasMore) {
    const lastKey = keys[keys.length - 1]
    nextPosition = { key: { ts: lastKey.ts, id: lastKey.id }, offset: 0, inclusive: false, index, byteOffset: null, callIndex: 0, cmdOffset: 0, cmdByteOffset: null }
  }

  const dims = computeDims(messages, metas, knownTotal, nextPosition != null)

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
