import fs from 'node:fs'
import path from 'node:path'

export function ensureDir (p) { fs.mkdirSync(p, { recursive: true }) }

export function atomicWrite (file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

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
