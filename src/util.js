import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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

const CHUNK = 1 << 20 // 1 Mo

/**
 * Parcours SYNCHRONE d'un fichier texte ligne à ligne, en flux.
 * onLine(line) reçoit chaque ligne non vide. Retourne le nombre de lignes traitées.
 * L'empreinte mémoire est O(CHUNK), indépendante de la taille du fichier — un shard
 * de plusieurs Go se parcourt comme un petit.
 */
export function streamLines (file, onLine) {
  if (!fs.existsSync(file)) return 0
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return 0 }
  const buf = Buffer.alloc(CHUNK)
  let carry = ''
  let n = 0
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK, null)
      if (read === 0) break
      carry += buf.toString('utf8', 0, read)
      let start = 0
      for (;;) {
        const idx = carry.indexOf('\n', start)
        if (idx < 0) break
        const line = carry.slice(start, idx)
        start = idx + 1
        const s = line.trim()
        if (!s) continue
        n++
        if (onLine(s, n) === false) { fs.closeSync(fd); return n }
      }
      carry = carry.slice(start)
    }
    const tail = carry.trim()
    if (tail) { n++; if (onLine(tail, n) === false) return n }
  } finally {
    fs.closeSync(fd)
  }
  return n
}

/**
 * Lecture d'un fichier par blocs d'octets bornés, avec recouvrement aux frontières
 * (un match à cheval sur deux blocs n'est pas perdu). onBlock(blockString) ; si elle
 * retourne false, le parcours s'arrête. Empreinte mémoire O(blockSize + overlap).
 */
export function streamBlocks (file, { blockSize = 1 << 20, overlap = 64, onBlock } = {}) {
  let stat
  try { stat = fs.statSync(file) } catch { return false }
  const fd = fs.openSync(file, 'r')
  try {
    let pos = 0
    while (pos < stat.size) {
      const len = Math.min(blockSize + overlap, stat.size - pos)
      const buf = Buffer.alloc(len)
      const read = fs.readSync(fd, buf, 0, len, pos)
      if (read <= 0) break
      if (onBlock(buf.toString('utf8', 0, read), pos) === false) return false
      pos += blockSize
    }
    return true
  } finally {
    fs.closeSync(fd)
  }
}

/** md5 d'un fichier, en blocs bornés (jamais le fichier entier en RAM). */
export function md5File (file) {
  const h = crypto.createHash('md5')
  streamBlocks(file, { blockSize: 1 << 20, overlap: 0, onBlock: (blk) => { h.update(blk) } })
  return h.digest('hex')
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
