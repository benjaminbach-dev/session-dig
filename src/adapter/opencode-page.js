// Adaptateur opencode paginé (change scale-corpus) : lecture de la source par lots
// bornés, watermark EN REQUÊTE (filtre time_updated exécuté par la base — jamais un
// parcours complet des tables filtré après coup). La mémoire est bornée par la taille
// de lot, indépendamment de la taille de la source (la base PC réelle fait 4 Go :
// aucune matérialisation intégrale).
//
// Stratégie de lecture du delta (D3) : si la source porte un index dont time_updated
// est une colonne de tête, la pagination keyset sur (time_updated, id) est indexée —
// coût réel O(delta). Sinon (opencode.db actuel : index (session_id, time_created, id)
// uniquement), UNE passe en flux avec le filtre watermark dans la requête — la base
// exécute le filtre, seule l'I/O de scan est payée, jamais de matérialisation.
// L'extraction d'un message (parts → événement canonique) reste dans
// opencode-extract.js (point de vérité unique partagé).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractSessionRow, extractMessage } from './opencode-extract.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

function openReadonly (dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`base source introuvable : ${dbPath} (lancer opencode au moins une fois, ou passer --db)`)
  }
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    // WAL actif (opencode en cours) : copie tripartite en tmp puis lecture de la copie.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-src-'))
    const copy = path.join(tmp, 'src.db')
    for (const ext of ['', '-wal', '-shm']) {
      const from = dbPath + ext
      if (fs.existsSync(from)) fs.copyFileSync(from, copy + ext)
    }
    return new Database(copy, { readonly: true, fileMustExist: true })
  }
}

function repoFromDirectory (directory) {
  if (!directory || directory === '/' || directory === os.homedir()) return null
  return path.basename(directory) || null
}

/** Un index source couvre-t-il time_updated en tête ? (pagination indexée du delta) */
function hasTimeUpdatedIndex (db) {
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('session','message')").all()
  return idx.some(r => (r.sql || '').includes('time_updated'))
}

export async function adaptPaged (dbPath, since = {}, opts = {}, onBatch) {
  const sinceMsg = since.message ?? -1
  const sinceSes = since.session ?? -1
  const batchSize = Math.max(1, opts.batchSize || 2000)
  const db = openReadonly(dbPath)
  try {
    const indexed = hasTimeUpdatedIndex(db)

    // ── sessions (table légère, une seule passe paginée) ──
    const sesQ = db.prepare(`SELECT * FROM session
      WHERE time_updated > ? ${indexed ? 'AND (time_updated > ? OR (time_updated = ? AND id > ?))' : ''}
      ${indexed ? 'ORDER BY time_updated, id' : 'ORDER BY id'} LIMIT ?`)
    let lastUp = -1
    let lastId = ''
    for (;;) {
      const rows = indexed
        ? sesQ.all(sinceSes, lastUp, lastUp, lastId, batchSize)
        : sesQ.all(sinceSes, batchSize)
      if (!rows.length) break
      const sessions = rows.map(extractSessionRow)
      onBatch({
        sessions,
        events: [],
        rawOutputs: [],
        maxMessageUpdate: -1,
        maxSessionUpdate: rows[rows.length - 1].time_updated
      })
      if (!indexed) break // table non indexée : une seule passe (légère), tri par id
      lastUp = rows[rows.length - 1].time_updated
      lastId = rows[rows.length - 1].id
      if (rows.length < batchSize) break
    }

    // ── messages : delta filtré PAR LA BASE (watermark en requête) ──
    // Version en flux : un seul parcours (scan indexé si l'index existe), lots bornés.
    const msgQ = db.prepare(`SELECT * FROM message WHERE time_updated > ? ORDER BY time_created, id`)

    const repoQ = db.prepare('SELECT directory FROM session WHERE id = ?')
    const repoCache = new Map()
    const REPO_CACHE_MAX = 5000
    const repoOf = (sessionId) => {
      if (repoCache.has(sessionId)) return repoCache.get(sessionId)
      const row = repoQ.get(sessionId)
      const repo = row ? repoFromDirectory(row.directory) : null
      if (repoCache.size >= REPO_CACHE_MAX) repoCache.clear()
      repoCache.set(sessionId, repo)
      return repo
    }

    const partQ = db.prepare('SELECT id, data FROM part WHERE message_id = ? ORDER BY id')

    let events = []
    let rawOutputs = []
    let batchMaxUp = -1
    const flush = () => {
      onBatch({
        sessions: [], events, rawOutputs,
        maxMessageUpdate: batchMaxUp, maxSessionUpdate: -1
      })
      events = []
      rawOutputs = []
      batchMaxUp = -1
    }
    for (const m of msgQ.iterate(sinceMsg)) {
      if (m.time_updated > batchMaxUp) batchMaxUp = m.time_updated
      repoCache.delete(m.session_id) // une session peut changer de directory
      const parts = partQ.all(m.id).map(p => {
        let data
        try { data = JSON.parse(p.data) } catch { return null }
        return { rowId: p.id, data }
      }).filter(Boolean)
      const r = extractMessage(m, parts, repoOf)
      if (r) {
        if (r.event) events.push(r.event)
        for (const ro of r.rawOutputs) rawOutputs.push(ro)
      }
      if (events.length >= batchSize) flush()
    }
    if (events.length) flush()
  } finally {
    db.close()
  }
}
