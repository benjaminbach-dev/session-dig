// Curseurs opaques INERTES du handler read (sous-lot M3b2).
//
// Un curseur est un JETON ALÉATOIRE (256 bits, 64 hex) échangé avec un état borné
// gardé en MÉMOIRE PROCESS-LOCALE : l'état n'est jamais persisté, jamais journalisé
// et ne contient NI texte NI `raw`. La durée de vie et la borne mémoire sont
// documentées : `CURSOR_CACHE_MAX` entrées, `CURSOR_TTL_MS` (15 min), éviction FIFO
// à l'insertion et purge des entrées expirées à la lecture. Un jeton inconnu,
// altéré, étranger, expiré, évincé ou perdu au redémarrage est refusé
// (`invalid_cursor` côté handler) — jamais réinterprété comme une nouvelle requête.
import crypto from 'node:crypto'

export const CURSOR_TTL_MS = 15 * 60 * 1000
export const CURSOR_CACHE_MAX = 256
/** Jeton : 256 bits en hexadécimal (64 caractères), très en deçà de 2048. */
export const CURSOR_TOKEN_BYTES = 32
const TOKEN_RE = /^[0-9a-f]{64}$/

export function isCursorToken (token) {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

export class CursorStore {
  constructor ({ ttlMs = CURSOR_TTL_MS, max = CURSOR_CACHE_MAX, now = Date.now } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('CursorStore : ttlMs doit être un entier sûr positif')
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error('CursorStore : max doit être un entier sûr positif')
    if (typeof now !== 'function') throw new Error('CursorStore : now doit être une fonction')
    this.ttlMs = ttlMs
    this.max = max
    this.now = now
    this.map = new Map() // token → { state, expiresAt }
  }

  get size () { return this.map.size }

  /** Enregistre un état et retourne un jeton neuf (jamais réutilisé). */
  create (state) {
    const token = crypto.randomBytes(CURSOR_TOKEN_BYTES).toString('hex')
    const expiresAt = this.now() + this.ttlMs
    this.map.set(token, { state, expiresAt })
    this._evict()
    return token
  }

  /** État associé, ou `null` (inconnu, expiré, évincé). Purge l'expiré au passage. */
  get (token) {
    if (!isCursorToken(token)) return null
    const entry = this.map.get(token)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) { this.map.delete(token); return null }
    return entry.state
  }

  /** Retire un jeton (ex. après émission d'un curseur non final). */
  delete (token) { this.map.delete(token) }

  /** Purge TOTALE : arrêt normal, aucun travail de fond ne survit. */
  clear () { this.map.clear() }

  _evict () {
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
}
