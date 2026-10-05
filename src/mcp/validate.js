// Validation applicative des entrées MCP (lot M1a).
//
// Applique les règles que Zod ne peut pas exprimer sur un objet pur (règles
// croisées du curseur read), ramène au plafond les valeurs valides et retourne
// des ADAPTATIONS explicites. Les messages d'erreur ne citent que des noms de
// champs du schéma (ensemble fermé), jamais les valeurs reçues.
import { parseDateBound } from '../util.js'
import { searchInputSchema, readInputSchema, statusInputSchema } from './schemas.js'
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_HITS,
  MAX_SEARCH_CTX,
  MAX_READ_CTX,
  MAX_READ_TAIL,
  MAX_READ_CHARS
} from './constants.js'
import { invalidParams, invalidAnchor } from './errors.js'

/**
 * Parse strict SANS coercition : `undefined` reste `undefined` et échoue sauf si
 * l'appelant a réellement substitué une valeur par défaut. `null`, tableau ou
 * type inattendu échouent (invalid_params).
 */
export function parseStrict (schema, raw) {
  const result = schema.safeParse(raw)
  if (!result.success) throw invalidParams()
  return result.data
}

/** Ramène une valeur numérique valide au plafond, avec adaptation explicite. */
export function clampCeiling (field, value, ceiling) {
  if (value <= ceiling) return { value, adaptation: null }
  return {
    value: ceiling,
    adaptation: { field, requested: value, applied: ceiling, reason: 'plafond appliqué' }
  }
}

function normalizeBound (field, value, end) {
  if (value === undefined) return null
  if (typeof value === 'number') return value
  const ts = parseDateBound(value, end)
  if (ts == null) throw invalidParams()
  return ts
}

function normalizeLimit (field, value, fallback, ceiling) {
  const requested = value === undefined ? fallback : value
  const { value: applied, adaptation } = clampCeiling(field, requested, ceiling)
  return { value: applied, adaptations: adaptation ? [adaptation] : [] }
}

/**
 * Validation search : retourne `{ value, adaptations }` (bornes temporelles
 * normalisées, limite et ctx effectifs). Le scoring n'est PAS dupliqué. `source`
 * inconnu passe tel quel (zéro hit attendu côté moteur, jamais une erreur).
 *
 * Règle CROISÉE `query`/`sort` (le schéma laisse `query` structurellement
 * optionnelle) : `query` est obligatoire si `sort` est absent ou `relevance` ;
 * son OMISSION PHYSIQUE n'est admise qu'en `oldest`/`newest` (exploration sans
 * mots-clés). Une valeur de `sort` inconnue est déjà refusée par le schéma. La
 * distinction porte sur la PRÉSENCE PHYSIQUE du champ, jamais sur son contenu :
 * une requête fournie vide/en espaces/sans terme exploitable est refusée par le
 * schéma (`min(1)` + `EXPLOITABLE`) ou par le moteur (`no_terms`), jamais
 * convertie en exploration.
 */
export function validateSearchInput (raw) {
  const data = parseStrict(searchInputSchema, raw)
  const adaptations = []
  const limit = normalizeLimit('limit', data.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_HITS)
  const ctx = normalizeLimit('ctx', data.ctx, 0, MAX_SEARCH_CTX)
  adaptations.push(...limit.adaptations, ...ctx.adaptations)
  const sort = data.sort ?? 'relevance'
  const hasQuery = Object.hasOwn(data, 'query')
  if (hasQuery ? data.query === undefined : sort === 'relevance') throw invalidParams()
  return {
    value: {
      query: hasQuery ? data.query : null,
      sort,
      repo: data.repo ?? null,
      session: data.session ?? null,
      after: normalizeBound('after', data.after, false),
      before: normalizeBound('before', data.before, true),
      model: data.model ?? null,
      role: data.role ?? null,
      agent: data.agent ?? null,
      source: data.source ?? null,
      limit: limit.value,
      ctx: ctx.value
    },
    adaptations
  }
}

/**
 * Validation read. Deux formes exclusives : continuation (`cursor` SEUL, valeur
 * opaque conservée sans décodage — la validation authentifiée est M3) ; nouvelle
 * requête (`session` obligatoire). Un `at` vide donne `invalid_anchor` ; la
 * validation calendaire stricte de l'ancre est M3. Aucune vue n'est lue ici.
 */
export function validateReadInput (raw) {
  const data = parseStrict(readInputSchema, raw)
  const initialKeys = ['session', 'around', 'ctx', 'tail', 'at', 'chars', 'full']
  const hasCursor = data.cursor !== undefined
  const presentInitial = initialKeys.filter(k => data[k] !== undefined)

  if (hasCursor) {
    if (presentInitial.length) throw invalidParams()
    return { value: { cursor: data.cursor }, adaptations: [] }
  }

  if (data.session === undefined) throw invalidParams()
  if (data.at !== undefined && data.at.trim() === '') throw invalidAnchor()

  const adaptations = []
  const push = (r) => { if (r.adaptation) adaptations.push(r.adaptation); return r.value }
  return {
    value: {
      session: data.session,
      around: data.around ?? null,
      ctx: data.ctx === undefined ? null : push(clampCeiling('ctx', data.ctx, MAX_READ_CTX)),
      tail: data.tail === undefined ? null : push(clampCeiling('tail', data.tail, MAX_READ_TAIL)),
      at: data.at ?? null,
      chars: data.chars === undefined ? null : push(clampCeiling('chars', data.chars, MAX_READ_CHARS)),
      full: data.full === true
    },
    adaptations
  }
}

/**
 * Validation status : `{}` UNIQUEMENT si les arguments sont réellement omis.
 * `null`, tableau ou tout paramètre explicite (dont `cursor`) sont refusés.
 */
export function validateStatusInput (raw) {
  const data = parseStrict(statusInputSchema, raw === undefined ? {} : raw)
  return { value: data, adaptations: [] }
}