// Extraction opencode (change scale-corpus) : les fonctions pures de l'adaptateur
// v0, partagées par la lecture intégrale (opencode.js, tests) et la lecture paginée
// (opencode-page.js, ingestion). Point de vérité unique de la forme canonique.
import path from 'node:path'
import os from 'node:os'

export function repoFromDirectory (directory) {
  if (!directory || directory === '/' || directory === os.homedir()) return null
  return path.basename(directory) || null
}

export function extractSessionRow (r) {
  return {
    schemaVersion: 1,
    id: r.id,
    title: r.title ?? null,
    directory: r.directory ?? null,
    repo: repoFromDirectory(r.directory),
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
  }
}

export function extractModel (data) {
  if (data.model && typeof data.model === 'object' && (data.model.providerID || data.model.modelID)) {
    return { providerID: data.model.providerID ?? null, modelID: data.model.modelID ?? null }
  }
  if (data.providerID || data.modelID) return { providerID: data.providerID ?? null, modelID: data.modelID ?? null }
  return { providerID: null, modelID: null }
}

export function normTokens (t) {
  if (!t) return null
  return {
    in: t.input ?? 0,
    out: t.output ?? 0,
    reasoning: t.reasoning ?? 0,
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0
  }
}

export function addTokens (a, b) {
  if (!a) return b
  if (!b) return a
  return {
    in: a.in + b.in, out: a.out + b.out, reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite
  }
}

// Commande lisible d'un appel d'outil : champ le plus parlant de state.input.
export function cmdFromInput (input) {
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
export function exitCodeFrom (state) {
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

export function rawContentFrom (state) {
  if (state == null) return null
  if (typeof state.output === 'string' && state.output) return state.output
  if (typeof state.raw === 'string' && state.raw) return state.raw
  return null
}

/**
 * Un message source + ses parts (rowId, data) → événement canonique + sorties brutes.
 * `repoOf(sessionId)` résout le repo (cache côté appelant). Retourne
 * { event, rawOutputs } ou null (rôle ignoré).
 */
export function extractMessage (m, parts, repoOf) {
  let data
  try { data = JSON.parse(m.data) } catch { return null }
  const role = data.role
  if (role !== 'user' && role !== 'assistant') return null

  const texts = parts.filter(p => p.data.type === 'text' && typeof p.data.text === 'string').map(p => p.data.text)
  const toolCalls = []
  const rawOutputs = []
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
    repo: repoOf(m.session_id) ?? null,
    tokens: tokens ?? { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: cost ?? 0
  }
  if (toolCalls.length) ev.toolCalls = toolCalls
  return { event: ev, rawOutputs }
}
