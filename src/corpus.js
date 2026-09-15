// Corpus : fusion incrémentale idempotente → events.jsonl / sessions.jsonl / raw/ / state.json.
// Le JSONL est la référence (archive) ; l'index FTS5 est une vue dérivée reconstruisable.
import fs from 'node:fs'
import path from 'node:path'
import { adapt } from './adapter/opencode.js'
import { readJsonl, atomicWrite, ensureDir } from './util.js'
import { corpusPaths, sourceDb } from './paths.js'

function readState (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

const sesSort = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const evSort = (a, b) => {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Ingestion : source → corpus. Incrémental par défaut (watermark time_updated),
 * --rebuild pour repartir de zéro. Retourne un rapport { added, updated, unchanged,
 * totals, rawWritten, watermark }.
 */
export async function ingest (opts = {}) {
  const root = opts.root ?? corpusPaths().root
  const dbPath = sourceDb(opts.db)
  const paths = corpusPaths(root)
  ensureDir(root)
  ensureDir(paths.raw)

  const rebuild = !!opts.rebuild
  const prev = rebuild ? {} : readState(paths.state)
  if (rebuild && fs.existsSync(paths.raw)) {
    // Rebuild = repartir de zéro : raw/ purgé puis régénéré (pas de fichiers orphelins).
    fs.rmSync(paths.raw, { recursive: true, force: true })
  }
  ensureDir(paths.raw)
  const since = {
    message: typeof prev.message === 'number' ? prev.message : -1,
    session: typeof prev.session === 'number' ? prev.session : -1
  }

  const { sessions, events, rawOutputs, maxMessageUpdate, maxSessionUpdate } = adapt(dbPath, since)

  // Corpus existant en mémoire (clé par id) — v0 : taille corpus ≈ taille mémoire OK.
  const sesById = new Map((rebuild ? [] : readJsonl(paths.sessions)).map(s => [s.id, s]))
  const evById = new Map((rebuild ? [] : readJsonl(paths.events)).map(e => [e.id, e]))

  let sesAdded = 0; let sesUpdated = 0
  for (const s of sessions) {
    const old = sesById.get(s.id)
    if (!old) { sesAdded++; sesById.set(s.id, s) } else if (JSON.stringify(old) !== JSON.stringify(s)) { sesUpdated++; sesById.set(s.id, s) }
  }

  let evAdded = 0; let evUpdated = 0; let evUnchanged = 0
  for (const e of events) {
    const old = evById.get(e.id)
    if (!old) { evAdded++; evById.set(e.id, e) } else if (JSON.stringify(old) !== JSON.stringify(e)) { evUpdated++; evById.set(e.id, e) } else evUnchanged++
  }

  // Écritures atomiques, ordre stable → identique octet par octet à re-ingestion/rebuild.
  atomicWrite(paths.sessions, [...sesById.values()].sort(sesSort).map(s => JSON.stringify(s)).join('\n') + '\n')
  atomicWrite(paths.events, [...evById.values()].sort(evSort).map(e => JSON.stringify(e)).join('\n') + '\n')

  // Sorties brutes : écrites seulement si nouvelles ou différentes (jamais de divergence).
  let rawWritten = 0
  for (const r of rawOutputs) {
    const file = path.join(paths.raw, `${r.id}.txt`)
    let same = false
    try { same = fs.readFileSync(file, 'utf8') === r.content } catch { same = false }
    if (!same) { atomicWrite(file, r.content); rawWritten++ }
  }

  const state = {
    source: dbPath,
    message: Math.max(since.message, maxMessageUpdate),
    session: Math.max(since.session, maxSessionUpdate),
    updatedAt: Date.now(),
    counts: { sessions: sesById.size, events: evById.size }
  }
  atomicWrite(paths.state, JSON.stringify(state, null, 2) + '\n')

  return {
    added: evAdded, updated: evUpdated, unchanged: evUnchanged,
    sessionsAdded: sesAdded, sessionsUpdated: sesUpdated,
    totals: { events: evById.size, sessions: sesById.size },
    rawWritten,
    watermark: { message: state.message, session: state.session },
    rebuild
  }
}

export function loadCorpus (root = corpusPaths().root) {
  const paths = corpusPaths(root)
  const events = readJsonl(paths.events)
  const sessions = readJsonl(paths.sessions)
  const byId = new Map(sessions.map(s => [s.id, s]))
  return { paths, events, sessions, sessionsById: byId }
}
