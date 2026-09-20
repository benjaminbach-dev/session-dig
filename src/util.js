import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export function ensureDir (p) { fs.mkdirSync(p, { recursive: true }) }

export function atomicWrite (file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

// ⚠ readJsonl charge le fichier entier : usage INTERDIT sur les chemins de commande
// (change scale-corpus, D4). Conservé pour les tests et les petits fichiers de
// métadonnées ; les parcours de corpus passent par streamLines (flux, mémoire bornée).
export function readJsonl (file) {
  if (!fs.existsSync(file)) return []
  const out = []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* ligne corrompue : ignorée sans crash */ }
  }
  return out
}

// ── scale-corpus : streaming (mémoire bornée, jamais le fichier entier en RAM) ──
// Passe corrective 20/09 (revue) : les fonctions de flux sont CORRECTES EN OCTETS.
// Découper un Buffer en chaînes via buf.toString('utf8', 0, n) corrompt tout caractère
// multi-octet coupé à la frontière d'un bloc (un « é » devient «  ») — les preuves
// brutes, elles, peuvent même ne pas être de l'UTF-8 du tout. D'où :
//   - streamLines : StringDecoder, qui bufferise les séquences UTF-8 incomplètes ;
//   - streamBytes : octets bruts, AUCUN décodage (empreinte md5 exacte, affichage raw
//     octet pour octet — un md5 calculé sur des chaînes décodées était faux dès qu'un
//     octet non-UTF-8 ou une coupure de frontière apparaissait) ;
//   - scanText   : recherche de sous-chaîne en flux, avec recouvrement piloté par la
//     longueur de l'aiguille (un match plus long que le recouvrement n'est plus perdu)
//     et dédoublonnage par position (le recouvrement n'est plus réémis en double).

const CHUNK = 1 << 20 // 1 Mo

/**
 * Parcours SYNCHRONE d'un fichier texte ligne à ligne, en flux.
 * onLine(line) reçoit chaque ligne non vide ; `return false` arrête le parcours.
 * Retourne le nombre de lignes traitées. Empreinte O(chunkSize + ligne courante),
 * indépendante de la taille du fichier. Les caractères multi-octets coupés à la
 * frontière d'un chunk sont reconstitués (StringDecoder), jamais corrompus.
 */
export function streamLines (file, onLine, { chunkSize = CHUNK } = {}) {
  if (!fs.existsSync(file)) return 0
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return 0 }
  const buf = Buffer.alloc(chunkSize)
  const dec = new StringDecoder('utf8')
  let carry = ''
  let n = 0
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, chunkSize, null)
      if (read === 0) break
      carry += dec.write(buf.subarray(0, read))
      let start = 0
      for (;;) {
        const idx = carry.indexOf('\n', start)
        if (idx < 0) break
        const s = carry.slice(start, idx).trim()
        start = idx + 1
        if (!s) continue
        n++
        if (onLine(s, n) === false) return n
      }
      carry = carry.slice(start)
    }
    carry += dec.end() // séquence finale éventuellement incomplète : flush du décodeur
    const tail = carry.trim()
    if (tail) { n++; if (onLine(tail, n) === false) return n }
  } finally {
    fs.closeSync(fd)
  }
  return n
}

/**
 * Lecture d'un fichier PAR OCTETS (aucun décodage), en blocs bornés.
 * onChunk(buf, len) ; `return false` arrête. Retourne le nombre total d'octets lus.
 * C'est le primitive d'intégrité : md5, affichage de preuve, toute utilisation où
 * les octets doivent sortir EXACTEMENT comme ils sont entrés.
 */
export function streamBytes (file, onChunk, { chunkSize = CHUNK } = {}) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return 0 }
  let total = 0
  try {
    const buf = Buffer.alloc(chunkSize)
    for (;;) {
      const read = fs.readSync(fd, buf, 0, chunkSize, null)
      if (read <= 0) break
      total += read
      if (onChunk(buf.subarray(0, read), read) === false) break
    }
  } finally {
    fs.closeSync(fd)
  }
  return total
}

/** md5 d'un fichier : hash des OCTETS, en blocs bornés (jamais le fichier en RAM).
 *  Un md5 calculé sur des chaînes décodées diffère du md5 réel dès le premier octet
 *  non-UTF-8 (les preuves brutes peuvent en contenir) ou coupure multi-octet. */
export function md5File (file) {
  const h = crypto.createHash('md5')
  streamBytes(file, (b) => { h.update(b) })
  return h.digest('hex')
}

function countNl (s, from, to) {
  let n = 0
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/**
 * Scan littéral insensible à la casse Unicode, mémoire O(chunkSize + aiguille).
 * StringDecoder préserve l'UTF-8 ; le curseur de recherche est distinct du
 * recouvrement conservé pour les matches incomplets et le contexte (64 caractères).
 * onMatch(contexte borné à 200 caractères, ligne absolue) : false arrête le scan.
 */
export function scanText (file, needle, { chunkSize = CHUNK, onMatch } = {}) {
  needle = String(needle)
  if (!needle) return 0
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize invalide')
  // Échappement : la requête reste une sous-chaîne, jamais une expression régulière.
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const buf = Buffer.alloc(chunkSize)
  const dec = new StringDecoder('utf8')
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return 0 }
  let window = ''
  let from = 0
  let newlines = 0
  let matches = 0
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, chunkSize, null)
      const eof = read === 0
      window += eof ? dec.end() : dec.write(buf.subarray(0, read))
      re.lastIndex = from
      let m
      let lineCursor = 0
      let lineNo = newlines + 1
      while ((m = re.exec(window)) !== null) {
        const p = m.index
        lineNo += countNl(window, lineCursor, p)
        lineCursor = p
        const ls = p === 0 ? 0 : window.lastIndexOf('\n', p - 1) + 1
        let le = window.indexOf('\n', p + m[0].length)
        if (le < 0) le = window.length
        matches++
        if (onMatch?.(window.slice(ls, le).trim().slice(0, 200), lineNo) === false) return matches
        // Autorise les occurrences chevauchantes, sans couper une paire UTF-16.
        from = p + (window.codePointAt(p) > 0xffff ? 2 : 1)
        re.lastIndex = from
      }
      if (eof) break
      // Les débuts antérieurs à cette borne ont tous été examinés intégralement.
      from = Math.max(from, window.length - needle.length + 1, 0)
      if (from > 0 && /[\uDC00-\uDFFF]/.test(window[from] || '')) from--
      let drop = Math.max(0, window.length - needle.length - 64)
      if (drop > 0 && /[\uDC00-\uDFFF]/.test(window[drop])) drop--
      newlines += countNl(window, 0, drop)
      window = window.slice(drop)
      from -= drop
    }
  } finally {
    fs.closeSync(fd)
  }
  return matches
}

// '2026' | '2026-06' | '2026-06-01' | ISO → borne ms. end=true → fin de période.
export function parseDateBound (s, end = false) {
  if (!s) return null
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s)
  if (m) {
    const y = +m[1]
    const mo = m[2] ? +m[2] : null
    const d = m[3] ? +m[3] : null
    if (end) {
      if (d) return Date.UTC(y, mo - 1, d, 23, 59, 59, 999)
      if (mo) return Date.UTC(y, mo, 0, 23, 59, 59, 999)
      return Date.UTC(y + 1, 0, 0, 23, 59, 59, 999)
    }
    return Date.UTC(y, mo ? mo - 1 : 0, d || 1)
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

export function fmtTs (ms) {
  if (!ms) return '?'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

export function fmtCost (c) {
  if (c == null) return '—'
  if (c === 0) return '$0'
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(2)}`
}
