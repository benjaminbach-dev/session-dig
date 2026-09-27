// Fixture pi synthétique (change add-pi-adapter) : générateurs de sessions pi
// JSONL — 100 % synthétiques, jamais d'extrait de session réelle (D6). Formes
// des lignes mirrorées sur les données observées : enveloppe
// {type, id, parentId, timestamp ISO} + message plat/imbriqué selon le rôle.
import fs from 'node:fs'
import path from 'node:path'

export const T0 = 1_800_000_000_000 // ms epoch (ordre de grandeur fixe, 2027-01-15)

let counter = 0

// UUID synthétique unique (forme UUIDv7 : les mêmes bits que la source).
export function fakeUuid () {
  counter++
  return 'aaaaaaaa-0000-7000-8000-' + String(counter).padStart(12, '0')
}

export function iso (ms) {
  return new Date(ms).toISOString()
}

// Enveloppe d'une ligne pi (id de ligne = id court hexadécimal, comme la source).
export function envelope (type, ms, extra = {}) {
  counter++
  return {
    type,
    id: counter.toString(16).padStart(8, '0'),
    parentId: null,
    timestamp: iso(ms),
    ...extra
  }
}

// Ligne d'en-tête de session pi.
export function sessionLine (uuid, ms, cwd) {
  return JSON.stringify({ type: 'session', version: 3, id: uuid, timestamp: iso(ms), cwd })
}

export function messageLine (ms, message, id = null) {
  const env = envelope('message', ms, { message })
  if (id != null) env.id = id
  return JSON.stringify(env)
}

export function infoLine (ms, name, id = null) {
  const env = envelope('session_info', ms, { name })
  if (id != null) env.id = id
  return JSON.stringify(env)
}

// Écrit une session pi (lignes JSONL) sous <base>/<dirName>/<fileName> — la base
// est le répertoire temporaire du test, JAMAIS ~/.pi (lecture seule, D6).
export function writePiSession (base, dirName, fileName, lines) {
  const abs = path.join(base, dirName, fileName)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, lines.join('\n') + (lines.length ? '\n' : ''))
  return path.join(dirName, fileName) // relPath tel que suivi dans l'état
}
