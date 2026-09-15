// Adaptateur opencode : opencode.db (SQLite, drizzle) → événements/sessions canoniques.
// Lecture seule stricte (readonly) ; si la base est verrouillée par une session active
// (WAL/shm), repli sur copie temporaire — jamais d'écriture dans la source.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function openReadonly (dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`base source introuvable : ${dbPath} (lancer opencode au moins une fois, ou passer --db)`)
  }
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch (e) {
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

function extractModel (data) {
  if (data.model && typeof data.model === 'object' && (data.model.providerID || data.model.modelID)) {
    return { providerID: data.model.providerID ?? null, modelID: data.model.modelID ?? null }
  }
  if (data.providerID || data.modelID) return { providerID: data.providerID ?? null, modelID: data.modelID ?? null }
  return { providerID: null, modelID: null }
}

function normTokens (t) {
  if (!t) return null
  return {
    in: t.input ?? 0,
    out: t.output ?? 0,
    reasoning: t.reasoning ?? 0,
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0
  }
}

function addTokens (a, b) {
  if (!a) return b
  if (!b) return a
  return {
    in: a.in + b.in, out: a.out + b.out, reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite
  }
}

// Commande lisible d'un appel d'outil : champ le plus parlant de state.input.
function cmdFromInput (input) {
  if (input == null) return null
  if (typeof input === 'string') return input.slice(0, 200)
  if (typeof input !== 'object') return String(input).slice(0, 200)
  if (typeof input.command === 'string' && input.command) return input.command
  for (const k of ['query', 'pattern', 'url', 'file', 'path', 'filePath', 'description', 'prompt', 'note', 'name']) {
    if (typeof input[k] === 'string' && input[k]) return `${k}: ${input[k]}`
  }
  try {
    const s = JSON.stringify(input)
    return s.length > 200 ? `${s.slice(0, 197)}...` : s
  } catch { return null }
}

// exitCode au mieux : la source ne l'expose pas toujours (spec : omis sinon).
function exitCodeFrom (state) {
  const cands = [
    state?.metadata?.exitCode, state?.exitCode, state?.error?.exitCode,
    state?.metadata?.exit_code, state?.error?.exit_code
  ]
  for (const c of cands) {
    if (typeof c === 'number') return c
    if (typeof c === 'string' && /^-?\d+$/.test(c.trim())) return parseInt(c.trim(), 10)
  }
  return undefined
}

function rawContentFrom (state) {
  if (state == null) return null
  if (typeof state.output === 'string' && state.output) return state.output
  if (typeof state.raw === 'string' && state.raw) return state.raw
  return null
}

/**
 * Extrait depuis opencode.db les sessions et messages nouveaux/modifiés
 * (time_updated > since.*) et les sorties brutes d'outils associées.
 * Retourne { sessions, events, rawOutputs, maxMessageUpdate, maxSessionUpdate }.
 */
export function adapt (dbPath, since = {}) {
  const sinceMsg = since.message ?? -1
  const sinceSes = since.session ?? -1
  const db = openReadonly(dbPath)
  try {
    const sessions = []
    const events = []
    const rawOutputs = []
    let maxMsgUp = -1
    let maxSesUp = -1

    const sesRows = db.prepare('SELECT * FROM session WHERE time_updated > ?').all(sinceSes)
    const repoBySession = new Map()
    for (const r of sesRows) {
      if (r.time_updated > maxSesUp) maxSesUp = r.time_updated
      repoBySession.set(r.id, repoFromDirectory(r.directory))
      sessions.push({
        schemaVersion: 1,
        id: r.id,
        title: r.title ?? null,
        directory: r.directory ?? null,
        repo: repoBySession.get(r.id),
        tsCreated: r.time_created,
        tsUpdated: r.time_updated,
        cost: r.cost ?? 0,
        tokens: {
          in: r.tokens_input ?? 0,
          out: r.tokens_output ?? 0,
          reasoning: r.tokens_reasoning ?? 0,
          cacheRead: r.tokens_cache_read ?? 0,
          cacheWrite: r.tokens_cache_write ?? 0
        },
        ...(r.parent_id ? { parentSession: r.parent_id } : {})
      })
    }

    // Repo des sessions non modifiées (nécessaire aux nouveaux messages de sessions anciennes).
    if (sesRows.length < 1) {
      // rien : on pompe la table légère id/directory si besoin ci-dessous
    }
    const dirRows = db.prepare('SELECT id, directory FROM session').all()
    for (const r of dirRows) {
      if (!repoBySession.has(r.id)) repoBySession.set(r.id, repoFromDirectory(r.directory))
    }

    const msgRows = db.prepare('SELECT * FROM message WHERE time_updated > ? ORDER BY time_created, id').all(sinceMsg)
    if (msgRows.length > 0) {
      // Parts groupées par message (lecture complète : ~20k lignes, rapide et simple en v0).
      const partRows = db.prepare('SELECT * FROM part ORDER BY time_created, id').all()
      const partsByMsg = new Map()
      for (const p of partRows) {
        if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, [])
        let data
        try { data = JSON.parse(p.data) } catch { continue }
        partsByMsg.get(p.message_id).push({ rowId: p.id, data })
      }

      for (const m of msgRows) {
        if (m.time_updated > maxMsgUp) maxMsgUp = m.time_updated
        let data
        try { data = JSON.parse(m.data) } catch { continue }
        const role = data.role
        if (role !== 'user' && role !== 'assistant') continue

        const parts = (partsByMsg.get(m.id) || [])

        const texts = parts.filter(p => p.data.type === 'text' && typeof p.data.text === 'string').map(p => p.data.text)
        const toolCalls = []
        for (const { rowId, data: p } of parts) {
          if (p.type !== 'tool') continue
          const st = p.state
          const call = { tool: p.tool ?? null, cmd: cmdFromInput(st?.input) ?? null }
          const ec = exitCodeFrom(st)
          if (ec !== undefined) call.exitCode = ec
          const raw = rawContentFrom(st)
          if (raw) {
            call.rawRef = rowId
            rawOutputs.push({ id: rowId, content: raw })
          }
          toolCalls.push(call)
        }

        // tokens/cost : depuis message.data si présents, sinon somme des step-finish.
        let tokens = normTokens(data.tokens)
        let cost = typeof data.cost === 'number' ? data.cost : null
        if (!tokens || cost == null) {
          for (const { data: p } of parts) {
            if (p.type !== 'step-finish') continue
            tokens = addTokens(tokens, normTokens(p.tokens))
            if (typeof p.cost === 'number') cost = (cost ?? 0) + p.cost
          }
        }

        const ev = {
          schemaVersion: 1,
          id: m.id,
          sessionId: m.session_id,
          ts: m.time_created,
          role,
          text: texts.length ? texts.join('\n\n') : null,
          model: extractModel(data),
          agent: data.agent ?? null,
          repo: repoBySession.get(m.session_id) ?? null,
          tokens: tokens ?? { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: cost ?? 0
        }
        if (toolCalls.length) ev.toolCalls = toolCalls
        events.push(ev)
      }
    }

    return { sessions, events, rawOutputs, maxMessageUpdate: maxMsgUp, maxSessionUpdate: maxSesUp }
  } finally {
    db.close()
  }
}
