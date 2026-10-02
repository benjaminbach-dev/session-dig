// Handler MÉTIER `sdig_search` (sous-lot search B). Lecture seule, sans scoring
// dupliqué : la recherche et les voisins passent par le moteur partagé
// (`src/retriever/bm25.js`, mode `boundedText: true`), qui borne déjà les extraits
// et les textes DANS SQL. Ce module n'ajoute que l'ASSEMBLAGE MCP : références read
// obligatoires, groupement par session, fidélité pi des seules données rendues,
// voisins bornés/dédupliqués, et budget d'enveloppe exact (524 288 octets) avec
// priorités hits puis voisins, coupures et comptes exacts.
//
// Aucune pagination : `search` ne rend NI n'accepte de curseur (`cursor` est refusé
// par le schéma d'entrée). Aucun contenu intégral : `text`/`cmd` ne sont jamais
// chargés ; seuls des extraits bornés et des longueurs le sont — le texte complet
// s'obtient par `sdig_read`. Aucun chemin local n'est rendu.
import { openReadSnapshot } from './data.js'
import { search, searchNeighbors, isSearchQueryError, MAX_BOUNDED_EXCERPT_CHARS } from '../retriever/bm25.js'
import { measureSerialized } from './budget.js'
import {
  RESPONSE_BUDGET_BYTES,
  MAX_ID_STRING_CHARS,
  MAX_READ_MESSAGES,
  MAX_SEARCH_CTX,
  DEFAULT_SEARCH_LIMIT
} from './constants.js'
import { invalidParams, internalError } from './errors.js'
import { piFidelityNotice } from '../format.js'
import { fmtTs } from '../util.js'

// Plafonds locaux : la constante de borne d'extrait est partagée avec le moteur.
const MAX_EXCERPT_CHARS = MAX_BOUNDED_EXCERPT_CHARS
const MIN_EXCERPT_CHARS = 1
const MAX_DISTINCT_MESSAGES = MAX_READ_MESSAGES
// Réserve pour l'objet `truncated` ajouté en fin d'assemblage (dimensions voisins/
// messages) : mesurée dans la passe « hits d'abord » pour garantir que le budget
// reste tenu quand les voisins sont ajoutés ensuite.
const TRUNCATED_RESERVE_BYTES = 512

// Réserve d'enveloppe MAXIMALE : identifiant JSON-RPC chaîne de 128 caractères
// (borne validée du transport) et `content: []` (le serveur peut omettre le texte
// dupliqué). Mesurer cette enveloppe évite de renvoyer une charge que le serveur
// devrait ensuite rejeter.
const ENVELOPE_ID = 'x'.repeat(MAX_ID_STRING_CHARS)
function envelopeBytes (output) {
  return measureSerialized({ jsonrpc: '2.0', id: ENVELOPE_ID, result: { content: [], structuredContent: output } })
}

const ANSI_RE = /\x1b\[[0-9;]*m/g
const stripAnsi = (s) => (s || '').replace(ANSI_RE, '')

/** Coupe en POINTS DE CODE (jamais de demi-surrogate) ; rapide si déjà court. */
function codePointSlice (text, n) {
  if (text.length <= n) return text
  return [...text].slice(0, n).join('')
}
const codePointLen = (s) => [...s].length

const fidelityFor = (source) => (source === 'pi' ? piFidelityNotice() : undefined)

/**
 * Extrait d'un hit : colonne `text` par défaut, colonne `cmd` SANS MARQUEURS pour un
 * hit à COMMANDE SEULE (texte vide) — jamais un extrait vide inutilisable. `integral`
 * et `fullLen` viennent des indicateurs SQL EXACTS (`snipFull`/`snipCmdFull`,
 * longueurs réelles), jamais d'une comparaison de longueurs.
 */
function hitExcerptParts (h) {
  const textPlain = stripAnsi(h.snipPlain)
  const cmdPlain = stripAnsi(h.snipCmdPlain)
  const cmdOnly = textPlain.length === 0 && cmdPlain.length > 0
  const raw = cmdOnly ? cmdPlain : textPlain
  const fullLen = cmdOnly
    ? (Number.isInteger(h.snipCmdPlainLen) ? h.snipCmdPlainLen : cmdPlain.length)
    : (Number.isInteger(h.snipPlainLen) ? h.snipPlainLen : textPlain.length)
  const integral = cmdOnly ? h.snipCmdFull === 1 : h.snipFull === 1
  return { cmdOnly, raw, fullLen, integral }
}

const refOf = (sessionId, role, id) => ({ sessionId, messageId: role === 'title' ? null : id })

function buildHit (h, excerptChars) {
  const { cmdOnly, raw, fullLen, integral } = hitExcerptParts(h)
  const text = codePointSlice(raw, excerptChars)
  const shownLen = codePointLen(text)
  const out = {
    kind: h.role === 'title' ? 'title' : 'message',
    ref: refOf(h.session_id, h.role, h.id),
    ts: h.ts,
    date: fmtTs(h.ts),
    role: h.role,
    source: h.source,
    agent: h.agent ?? null,
    repo: h.repo ?? null,
    model: h.model ?? null,
    score: h.score,
    // `truncated` = extrait NON intégral, décidé par les indicateurs SQL EXACTS
    // (`snipFull`/`snipCmdFull`) et la coupe éventuelle (SQL ou budget) — jamais par
    // une comparaison de longueurs qu'une ellipse FTS peut tromper.
    excerpt: { text, truncated: !integral || shownLen < fullLen }
  }
  // Un extrait issu du champ `cmd` est IDENTIFIÉ (la référence read reste la même).
  if (cmdOnly) out.excerptKind = 'cmd'
  const fidelity = fidelityFor(h.source)
  if (fidelity) out.fidelity = fidelity
  return out
}

function buildNeighbor (nb, excerptChars) {
  const text = codePointSlice(nb.text ?? '', excerptChars)
  const out = {
    kind: 'message',
    ref: { sessionId: nb.session_id, messageId: nb.id },
    forRef: nb.forRef,
    ts: nb.ts,
    role: nb.role,
    source: nb.source,
    excerpt: { text, truncated: codePointLen(text) < (Number.isInteger(nb.textLen) ? nb.textLen : 0) }
  }
  const fidelity = fidelityFor(nb.source)
  if (fidelity) out.fidelity = fidelity
  return out
}

/** Groupes par session (méta title/repo), chacun rattachant hits et voisins rendus. */
function buildGroups (hitEntries, neighborEntries, meta) {
  const bySession = new Map()
  const ensure = (sessionId, source) => {
    let group = bySession.get(sessionId)
    if (!group) {
      const m = meta.get(sessionId)
      group = {
        sessionId,
        source,
        title: m && m.title != null ? m.title : null,
        repo: m && m.repo != null ? m.repo : null,
        hitRefs: [],
        neighborRefs: []
      }
      const fidelity = fidelityFor(source)
      if (fidelity) group.fidelity = fidelity
      bySession.set(sessionId, group)
    }
    return group
  }
  for (const h of hitEntries) ensure(h.ref.sessionId, h.source).hitRefs.push(h.ref)
  for (const n of neighborEntries) ensure(n.ref.sessionId, n.source).neighborRefs.push(n.ref)
  return [...bySession.values()]
}

function loadSessionMeta (view, sessionIds) {
  const ids = [...new Set(sessionIds)]
  const out = new Map()
  if (ids.length === 0) return out
  const placeholders = ids.map(() => '?').join(',')
  for (const row of view.all(`SELECT id, title, repo FROM sessions WHERE id IN (${placeholders})`, ...ids)) {
    out.set(row.id, row)
  }
  return out
}

function buildTruncated ({ hitCount, rawCount, excerptShown, excerptTotal, keptCount, poolSize, distinctCount, messagesCapped, knownTotal }) {
  const dimensions = []
  if (hitCount < rawCount) dimensions.push({ dimension: 'hits', retained: hitCount, total: knownTotal })
  // Quantité RÉELLE de texte affichée (points de code) vs total des extraits
  // sélectionnés : agrégat exact, jamais le plafond choisi.
  if (excerptShown < excerptTotal) dimensions.push({ dimension: 'excerpt_chars', retained: excerptShown, total: excerptTotal })
  if (poolSize > 0 && keptCount < poolSize) dimensions.push({ dimension: 'neighbors', retained: keptCount, total: poolSize })
  if (messagesCapped) dimensions.push({ dimension: 'messages', retained: distinctCount, total: null })
  return { dimensions }
}

function runSearch (view, value, adaptations, freshness) {
  const limit = Number.isInteger(value.limit) && value.limit >= 1 ? value.limit : DEFAULT_SEARCH_LIMIT
  const ctx = Number.isInteger(value.ctx) && value.ctx > 0 ? Math.min(value.ctx, MAX_SEARCH_CTX) : 0

  let raw
  try {
    raw = search(view, {
      q: value.query,
      repo: value.repo ?? null,
      session: value.session ?? null,
      after: value.after ?? null,
      before: value.before ?? null,
      model: value.model ?? null,
      role: value.role ?? null,
      agent: value.agent ?? null,
      source: value.source ?? null,
      limit,
      plain: true,
      boundedText: true
    })
  } catch (err) {
    // Requête sans terme exploitable (stopwords/ponctuation) : c'est une ENTRÉE
    // invalide, jamais une erreur interne. Tout le reste est borné par le moteur.
    if (isSearchQueryError(err)) throw invalidParams()
    throw err
  }

  const rawCount = raw.length
  const knownTotal = rawCount < limit ? rawCount : null
  if (rawCount === 0) {
    return { hits: [], neighbors: [], groups: [], count: 0, topK: limit, total: knownTotal, adaptations, freshness }
  }

  const meta = loadSessionMeta(view, raw.map((h) => h.session_id))

  const assemble = (hitCount, excerptChars, neighborPool, keptCount, messagesCapped) => {
    const hitsSlice = raw.slice(0, hitCount)
    const neighborsSlice = neighborPool.slice(0, keptCount)
    const hitEntries = hitsSlice.map((h) => buildHit(h, excerptChars))
    const neighborEntries = neighborsSlice.map((nb) => buildNeighbor(nb, excerptChars))
    const distinctCount = new Set([
      ...hitEntries.filter((h) => h.ref.messageId != null).map((h) => h.ref.messageId),
      ...neighborEntries.map((n) => n.ref.messageId)
    ]).size
    let excerptShown = 0
    let excerptTotal = 0
    for (const h of hitsSlice) { const f = hitExcerptParts(h).fullLen; excerptTotal += f; excerptShown += Math.min(excerptChars, f) }
    for (const nb of neighborsSlice) { const f = Number.isInteger(nb.textLen) ? nb.textLen : 0; excerptTotal += f; excerptShown += Math.min(excerptChars, f) }
    const truncated = buildTruncated({ hitCount, rawCount, excerptShown, excerptTotal, keptCount, poolSize: neighborPool.length, distinctCount, messagesCapped, knownTotal })
    // L'ajustement du plafond d'extrait (budget) est une ADAPTATION signalée, distincte
    // des coupures de `truncated`.
    const outAdaptations = excerptChars < MAX_EXCERPT_CHARS
      ? [...adaptations, { field: 'excerpt_chars', requested: MAX_EXCERPT_CHARS, applied: excerptChars, reason: 'budget' }]
      : adaptations
    const out = { hits: hitEntries, neighbors: neighborEntries, groups: buildGroups(hitEntries, neighborEntries, meta), count: hitCount, topK: limit, total: knownTotal, adaptations: outAdaptations, freshness }
    if (truncated.dimensions.length) out.truncated = truncated
    return out
  }
  const fits = (out) => envelopeBytes(out) <= RESPONSE_BUDGET_BYTES

  // ── 1. Hits d'abord : réduire le TEXTE, puis le nombre de hits ─────────────
  let hitCount = rawCount
  let excerptChars = MAX_EXCERPT_CHARS
  let chosen = null
  outer: while (hitCount >= 1) {
    while (true) {
      if (envelopeBytes(assemble(hitCount, excerptChars, [], 0, false)) + TRUNCATED_RESERVE_BYTES <= RESPONSE_BUDGET_BYTES) {
        chosen = { hitCount, excerptChars }
        break outer
      }
      if (excerptChars <= MIN_EXCERPT_CHARS) break
      excerptChars = Math.max(MIN_EXCERPT_CHARS, Math.floor(excerptChars / 2))
    }
    hitCount--
    excerptChars = MAX_EXCERPT_CHARS
  }
  // Un hit seul (extrait minimal) hors budget ⇒ erreur bornée, jamais une boucle.
  if (!chosen) throw internalError('budget_exhausted')
  ;({ hitCount, excerptChars } = chosen)

  // ── 2. Voisins ensuite, dans le budget RESTANT et sous le plafond de messages ──
  let neighborPool = []
  let keptCount = 0
  let messagesCapped = false
  if (ctx > 0) {
    const selectedRaw = raw.slice(0, hitCount)
    const hitIds = new Set(selectedRaw.filter((h) => h.role !== 'title').map((h) => h.id))
    neighborPool = searchNeighbors(view, selectedRaw, ctx).filter((nb) => !hitIds.has(nb.id))
    const distinct = new Set(hitIds)
    for (let i = 0; i < neighborPool.length; i++) {
      if (distinct.size >= MAX_DISTINCT_MESSAGES) { messagesCapped = true; break }
      if (!fits(assemble(hitCount, excerptChars, neighborPool, keptCount + 1, false))) break
      keptCount++
      distinct.add(neighborPool[i].id)
    }
  }

  // ── 3. Assemblage final exact : garantit le budget, jamais de dépassement ──
  let final = assemble(hitCount, excerptChars, neighborPool, keptCount, messagesCapped)
  while (!fits(final) && keptCount > 0) {
    keptCount--
    messagesCapped = false
    final = assemble(hitCount, excerptChars, neighborPool, keptCount, messagesCapped)
  }
  if (!fits(final)) {
    neighborPool = []
    keptCount = 0
    messagesCapped = false
    final = assemble(hitCount, excerptChars, [], 0, false)
    if (!fits(final)) throw internalError('budget_exhausted')
  }
  return final
}

/**
 * Fabrique le handler `sdig_search`. `config` est la configuration propriétaire
 * `{ root, sources }` attendue par `openReadSnapshot`. Retourne une fonction
 * synchrone `(value, adaptations) => sortie` (la `value` est celle déjà normalisée
 * par `validateSearchInput`).
 *
 * LIMITE DE DATES : `after`/`before` passent par `parseDateBound` PARTAGÉ, hérité et
 * PERMISSIF (dates partielles `AAAA`, `AAAA-MM` et repli `Date.parse`) ; seules les
 * formes non interprétables donnent `invalid_params`. La validation CALENDAIRE
 * STRICTE (UTC, jours réels, ancre) est une exigence de `read`, PAS de `search` : le
 * handler ne la revendique pas et ne modifie pas la sémantique CLI des dates.
 */
export function createSearchHandler (config) {
  return function sdigSearch (value, adaptations) {
    const input = value ?? {}
    const extraAdaptations = Array.isArray(adaptations) ? adaptations : []
    return openReadSnapshot(config, ({ view, freshness }) => runSearch(view, input, extraAdaptations, freshness)).data
  }
}

export { MAX_EXCERPT_CHARS as SEARCH_MAX_EXCERPT_CHARS }
