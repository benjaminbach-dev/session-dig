// Adaptateur pi (change add-pi-adapter) : sessions JSONL append-only sous
// `~/.pi/agent/sessions` → schéma canonique, même contrat de sortie que
// `adaptPaged` opencode (batches `{sessions, events, rawOutputs}` groupés par
// session) — la boucle d'ingestion du corpus fusionne les deux flux dans le
// même staging (corpus.js, phase implémentation, hors périmètre ici).
//
// Formes canoniques réutilisées depuis opencode-extract.js (point de vérité
// unique) : cmdFromInput, repoFromDirectory, normTokens. Champ `source: "pi"`
// sur toute session et tout événement produits (D1) ; ids préfixés `pi:`
// (sessions/événements), partIds qualifiés par session SANS préfixe de session
// (`pi:<uuid>:<id local>`, D5).
//
// Lecture seule stricte (D6) : jamais d'écriture sous le répertoire source ;
// sessions vivantes lues telles quelles — ligne finale non terminée ignorée
// sans erreur, ligne terminée au JSON invalide = échec explicite (D2).
import fs from 'node:fs'
import path from 'node:path'
import { cmdFromInput, repoFromDirectory, normTokens } from './opencode-extract.js'

// Types ignorés en v0 (perte documentée, réversible par rebuild) — D4.
const IGNORED_TYPES = new Set([
  'model_change', 'thinking_level_change', 'compaction', 'branch_summary',
  'custom', 'custom_message', 'context_edit'
])

// ── Lecture d'un fichier en lignes TERMINÉES (D2) ──
// Relecture INTÉGRALE à chaque changement (l'offset source n'est pas un état
// exploitable). Retourne les lignes terminées par \n avec leur numéro de ligne
// (0-based) et l'acquit : offset du dernier octet de la dernière ligne terminée
// — une ligne finale sans \n n'est jamais acquittée, le fichier sera relu.
function readTerminatedLines (absPath) {
  const data = fs.readFileSync(absPath)
  const lines = []
  let start = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push({ text: data.toString('utf8', start, i) })
      start = i + 1
    }
  }
  return { lines, ack: start }
}

// ── ts d'un événement : message.timestamp (ms) prioritaire, repli Date.parse de l'enveloppe ──
function tsOf (msgObj, envelope) {
  if (msgObj && Number.isFinite(msgObj.timestamp)) return msgObj.timestamp
  const iso = envelope && envelope.timestamp
  if (typeof iso === 'string') {
    const t = Date.parse(iso)
    if (Number.isFinite(t)) return t
  }
  return null
}

// ── model canonique depuis message.provider / message.model (la source les met à plat) ──
function modelOf (m) {
  const has = (m && typeof m.provider === 'string' && m.provider) ||
    (m && typeof m.model === 'string' && m.model)
  if (!has) return { providerID: null, modelID: null }
  return { providerID: m.provider ?? null, modelID: m.model ?? null }
}

// ── usage du message → tokens/cost canoniques (messages user → zéros, D4) ──
function metricsOf (msgObj, isUser) {
  if (isUser) return { tokens: { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
  const t = normTokens(msgObj && msgObj.usage) // {in, out, reasoning, cacheRead, cacheWrite}
  const c = msgObj && msgObj.usage && msgObj.usage.cost
  return {
    tokens: t ?? { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: c && typeof c.total === 'number' ? c.total : 0
  }
}

// ── parts text jointes par \n\n (parts thinking ignorées, D4) ──
function textOf (msgObj) {
  const content = msgObj && Array.isArray(msgObj.content) ? msgObj.content : []
  const texts = []
  for (const p of content) {
    if (p && p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
  }
  return texts.length ? texts.join('\n\n') : null
}

const isBashTool = (tool) => tool === 'bash' || tool === 'Bash'

// ── parts toolCall → toolCalls canoniques {tool, cmd} (cmd = champ le plus
// parlant des arguments) via cmdFromInput, D4 ; callId conservé pour le
// rattachement, retiré de la forme publiée).
function toolCallsOf (msgObj) {
  const content = msgObj && Array.isArray(msgObj.content) ? msgObj.content : []
  const calls = []
  for (const p of content) {
    if (p && p.type === 'toolCall') {
      calls.push({
        callId: p.id ?? null,
        tool: typeof p.name === 'string' ? p.name : (p.name != null ? String(p.name) : null),
        cmd: cmdFromInput(p.arguments) ?? null
      })
    }
  }
  return calls
}


// Derniere enveloppe du fichier, en parse defensif (timestamp de session).
function safeParse (text) {
  try { return JSON.parse(text) } catch { return null }
}

//
// ── Décodage d'un fichier pi (mapping D4/D5, appelé par adaptPi) ──
// Mapping d'un fichier : session, événements, preuves brutes, orphelins,
// compte des types ignorés et acquit — lignes TERMINÉES seulement (D2).
function decodePiFile (absPath, relPath, baseDir) {
  const { lines, ack } = readTerminatedLines(absPath)
  const empty = { session: null, events: [], rawOutputs: [], orphans: [], ignored: {}, ack }
  if (!lines.length) return empty

  const parseErr = (n, e) => new Error(`${path.join(baseDir, relPath)}:${n}: JSON invalide (${e.message})`)
  // Ligne 1 : session (métadonnées). cwd lu DANS la ligne — jamais le nom de
  // répertoire encodé (supposition D7.4). Un fichier de titre (session_info en
  // tête) est consommé : aucun objet produit.
  let header = null
  try { header = JSON.parse(lines[0].text) } catch (e) { throw parseErr(1, e) }
  const headType = header && header.type
  if (headType === 'session_info') return empty
  if (headType !== 'session') {
    throw new Error(`${path.join(baseDir, relPath)}:1: première ligne attendue de type "session" (type=${JSON.stringify(headType)})`)
  }
  const uuid = header.id
  if (typeof uuid !== 'string' || uuid === '') {
    throw new Error(`${path.join(baseDir, relPath)}:1: ligne "session" sans id`)
  }
  const sessionId = `pi:${uuid}`
  const directory = typeof header.cwd === 'string' ? header.cwd : null
  const repo = repoFromDirectory(directory)

  const events = []
  const rawOutputs = []
  const orphans = []
  const ignored = {}
  let firstUserText = null
  const callIndex = new Map() // toolCallId → { ev, call } (rattachement par id)
  const openBash = []         // appels bash antérieurs non résolus (ordre fichier)
  let lastInfo = null

  // Émission d'une preuve : partId QUALIFIÉ PAR SESSION (uuid SANS préfixe), D5.
  const qualify = (local) => `pi:${uuid}:${local}`
  const bump = (type) => { ignored[type] = (ignored[type] || 0) + 1 }

  // Attachement d'un toolResult (toolCallId exposé) : rawRef + exitCode sur
  // l'appel, contenu → rawOutputs. L'appel devient RÉSOLU (retiré des bash
  // ouverts). Sans appel correspondant : orphelin.
  const attachResult = (callId, content, exitCode) => {
    const ticket = callIndex.get(callId)
    if (!ticket) return null
    const partId = qualify(callId)
    if (typeof exitCode === 'number') ticket.call.exitCode = exitCode
    ticket.call.rawRef = partId
    ticket.call.resolved = true
    return { id: partId, content }
  }

  // Règle unique bash (D5) : le plus récent appel bash antérieur NON RÉSOLU du
  // même fichier (le plus récent dans l'ordre du fichier → pile LIFO, les
  // résolus sont sautés). Le cmd réel de l'exécution prime sur celui des
  // arguments de l'appel.
  const attachBash = (cmd, output, exitCode) => {
    let call = null
    while (openBash.length) {
      const cand = openBash.pop()
      if (!cand.resolved) { call = cand; break }
    }
    if (!call) return null
    const partId = qualify(call.callId)
    if (typeof cmd === 'string' && cmd) call.cmd = cmd
    if (typeof exitCode === 'number') call.exitCode = exitCode
    call.rawRef = partId
    return { id: partId, content: output }
  }

  const emitEvent = (m, lineId) => {
    const isUser = m.role === 'user'
    const met = metricsOf(m, isUser)
    const ev = {
      schemaVersion: 1,
      source: 'pi',
      id: `pi:${lineId}`,
      sessionId,
      ts: tsOf(m, header),
      role: m.role,
      text: textOf(m),
      model: modelOf(m),
      agent: null,
      repo,
      tokens: met.tokens,
      cost: met.cost
    }
    const calls = toolCallsOf(m)
    for (const call of calls) {
      if (call.callId != null && call.callId !== '') {
        callIndex.set(call.callId, { ev, call })
        if (isBashTool(call.tool)) openBash.push(call)
      }
    }
    if (calls.length) {
      ev.toolCalls = calls.map(({ callId, ...rest }) => rest)
    }
    events.push(ev)
  }

  // ── boucle de mapping (ordre fichier, lignes 2..N) ──
  for (let li = 1; li < lines.length; li++) {
    const text = lines[li].text
    if (text === '') continue // ligne vide inter-lignes : tolérée
    let line
    try { line = JSON.parse(text) } catch (e) { throw parseErr(li + 1, e) }
    const type = line && line.type
    if (type !== 'message') {
      if (type === 'session_info') {
        lastInfo = typeof line.name === 'string' && line.name ? line.name : lastInfo
      } else if (IGNORED_TYPES.has(type)) {
        bump(type)
      } else {
        bump(String(type)) // type inconnu : ignoré + compté (défensif)
      }
      continue
    }
    const m = line.message
    if (!m || typeof m !== 'object') { bump('message:malformed'); continue }
    // id de ligne : id d'enveloppe du message pi (unicité locale au fichier,
    // supposition D7.5), repli index de ligne si absent.
    const lineId = (line && typeof line.id === 'string' && line.id) ? line.id : String(li)
    const mrole = m.role
    if (mrole === 'user' || mrole === 'assistant') {
      emitEvent(m, lineId)
      if (mrole === 'user' && firstUserText === null) {
        const t = textOf(m)
        if (typeof t === 'string' && t) firstUserText = t
      }
      continue
    }
    if (mrole === 'toolResult') {
      const content = m.content && Array.isArray(m.content)
        ? m.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
        : ''
      const raw = m.toolCallId != null ? attachResult(m.toolCallId, content, undefined) : null
      if (raw) rawOutputs.push(raw)
      else {
        const partId = qualify(lineId)
        rawOutputs.push({ id: partId, content })
        orphans.push(partId)
        bump('orphan:toolResult')
      }
      continue
    }
    if (mrole === 'bashExecution') {
      const content = typeof m.output === 'string' ? m.output : ''
      const raw = attachBash(m.command, content, m.exitCode)
      if (raw) rawOutputs.push(raw)
      else {
        const partId = qualify(lineId)
        rawOutputs.push({ id: partId, content })
        orphans.push(partId)
        bump('orphan:bashExecution')
      }
      continue
    }
    // system ou autre rôle inconnu : ignoré + compté (défensif).
    bump(`role:${mrole}`)
  }

  // ----- fin de mapping -----
  // Titre de session (décision de l'étape, amendement D7.2) : session_info.name
  // (dernière occurrence), repli premier texte user première ligne <= 60
  // caractères, sinon null.
  const title = (typeof lastInfo === 'string' && lastInfo)
    ? lastInfo
    : (firstUserText !== null ? firstUserText.split('\n')[0].slice(0, 60) : null)
  const tsCreated = tsOf(null, header)
  const lastEnv = safeParse(lines[lines.length - 1].text)
  const tsUpdated = (lastEnv && tsOf(null, lastEnv)) || tsCreated
  // Appels bash restés sans résultat vu dans le fichier : orphelins (D5,
  // "appels sans preuve") - comptés, leur partId est signalé, jamais de rawRef
  // inventé : ni contenu inféré, ni événement fabriqué.
  for (const call of openBash) {
    if (call.rawRef === undefined) {
      // local = callId quand il existe, sinon "line-<numéro de ligne>" — un
      // id de ligne d'enveloppe ne peut pas entrer en collision (espaces disjoints).
      const partId = qualify(call.callId != null ? String(call.callId) : `line-${lines.length - 1}`)
      call.rawRef = partId
      orphans.push(partId)
    }
  }
  const session = {
    schemaVersion: 1,
    source: 'pi',
    id: sessionId,
    title,
    directory,
    repo,
    tsCreated,
    tsUpdated,
    tokens: { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0
  }
  return { session, events, rawOutputs, orphans, ignored, ack }
}

//
// Adaptateur pi : point d'entrée. opts.batchSize borne la taille des lots
// (défaut 2000). Avec onBatch, les objets sont envoyés par lots groupés par
// session (ordre sessionId croissant) ; retour : { files, orphans, ignored, acked }.
export function adaptPi (piDir, prevState = {}, opts = {}, onBatch = null) {
  if (typeof piDir !== 'string' || piDir === '') {
    throw new Error('adaptPi : chemin de la source pi requis')
  }
  let dirStat = null
  try { dirStat = fs.statSync(piDir) } catch { /* géré plus bas */ }
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`source pi introuvable : ${piDir}`)
  }
  const prevFiles = (prevState && prevState.files) || {}
  const batchSize = Math.max(1, (opts && opts.batchSize) || 2000)

  // ── Découverte des fichiers (récursif, *.jsonl, dotfiles ignorés) ──
  const files = []
  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(abs, r)
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ rel: r, abs })
    }
  }
  walk(piDir, '')
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  // ── Détection de changement : O(stat), pas de lecture des fichiers inchangés ──
  const changed = []
  for (const f of files) {
    let s
    try { s = fs.statSync(f.abs) } catch { continue }
    const prev = prevFiles[f.rel]
    if (prev && prev.size === s.size && prev.mtimeMs === s.mtimeMs) continue // inchangé
    changed.push({ ...f, size: s.size, mtimeMs: s.mtimeMs })
  }

  // ── Lecture et mapping des fichiers changés, ordre stable (relPath) ──
  const bySession = new Map() // sessionId → { session, events, rawOutputs, orphans, ignored }
  const allOrphans = []
  const ignoredTotals = {}
  const filesState = { ...prevFiles } // fichiers disparus retirés au COMMIT

  for (const f of changed) {
    const dec = decodePiFile(f.abs, f.rel, piDir)
    if (dec.session) {
      const key = dec.session.id
      if (!bySession.has(key)) bySession.set(key, { session: dec.session, events: [], rawOutputs: [], orphans: [] })
      const slot = bySession.get(key)
      slot.events.push(...dec.events)
      slot.rawOutputs.push(...dec.rawOutputs)
      slot.orphans.push(...dec.orphans)
    }
    filesState[f.rel] = { size: Math.min(dec.ack, f.size), mtimeMs: fs.statSync(f.abs).mtimeMs }
    for (const k of Object.keys(dec.ignored)) ignoredTotals[k] = (ignoredTotals[k] || 0) + dec.ignored[k]
  }

  // ── Production : sessions triées par id, événements groupés par session ──
  const batches = []
  let buf = { sessions: [], events: [], rawOutputs: [] }
  const pushBatch = () => {
    if (buf.sessions.length || buf.events.length || buf.rawOutputs.length) {
      batches.push(buf)
      buf = { sessions: [], events: [], rawOutputs: [] }
    }
  }
  for (const sid of [...bySession.keys()].sort()) {
    const slot = bySession.get(sid)
    buf.sessions.push(slot.session)
    buf.events.push(...slot.events)
    buf.rawOutputs.push(...slot.rawOutputs)
    allOrphans.push(...slot.orphans)
    if (buf.events.length >= batchSize) pushBatch()
  }
  pushBatch()

  if (typeof onBatch === 'function') {
    for (const b of batches) onBatch(b)
  }
  return {
    batches,
    files: filesState,
    orphans: allOrphans,
    ignored: ignoredTotals,
    acked: filesState
  }
}

// ── tri stable par id (même comparateur que le corpus) ──
export function compareById (a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
