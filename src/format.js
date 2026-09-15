// Affichage : hits regroupés par session (décision d'affichage, l'index reste au grain message).
import { fmtTs, fmtCost } from './util.js'
import { mergeWindows } from './read.js'

export function groupBySession (hits) {
  const groups = []
  const bySession = new Map()
  for (const h of hits) {
    if (!bySession.has(h.session_id)) {
      bySession.set(h.session_id, { sessionId: h.session_id, hits: [] })
      groups.push(bySession.get(h.session_id))
    }
    bySession.get(h.session_id).hits.push(h)
  }
  // Dans un groupe : chronologique. Entre groupes : meilleur score d'abord (ordre du tri interne).
  for (const g of groups) g.hits.sort((a, b) => a.ts - b.ts)
  return groups
}

function trunc (s, n) {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Rendu d'un événement du corpus (voisin de hit ou lecture de session). */
export function renderEvent (e, { mark = '  ', hit = null, plain = false } = {}) {
  const dim = plain ? '' : '\x1b[2m'
  const reset = plain ? '' : '\x1b[0m'
  const model = e.model && (e.model.providerID || e.model.modelID) ? `${e.model.providerID || ''}/${e.model.modelID || ''}` : ''
  const L = []
  const head = `${mark}${dim}${fmtTs(e.ts)} ${e.role}${model ? ` ${model}` : ''}${e.agent ? ` (${e.agent})` : ''}${e.cost ? ` ${fmtCost(e.cost)}` : ''}${reset}`
  L.push(head)
  if (hit && hit.snip && hit.snip.trim()) {
    for (const l of hit.snip.split('\n').slice(0, 3)) L.push(`    ${l}`)
  } else if (e.text) {
    for (const l of trunc(e.text, 400).split('\n').slice(0, 4)) L.push(`    ${l}`)
  }
  for (const c of e.toolCalls || []) {
    const ec = c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''
    const raw = c.rawRef ? ` → sdig raw ${c.rawRef}` : ''
    L.push(`    ${dim}· ${c.tool}: ${trunc(c.cmd || '', 120)}${ec}${raw}${reset}`)
  }
  return L.join('\n')
}

export function renderTerminal (hits, sessionsById, opts = {}) {
  const { ctx = 0, eventsBySession = null, plain = false } = opts
  const groups = groupBySession(hits)
  const lines = []
  const hitById = new Map(hits.map(h => [h.id, h]))

  for (const g of groups) {
    const ses = sessionsById.get(g.sessionId)
    const head = ses
      ? `── ${ses.title || '(sans titre)'} · ${ses.repo || '—'} · ${fmtTs(ses.tsCreated)}`
      : `── session ${g.sessionId}`
    lines.push(`\x1b[1m${head}\x1b[0m  \x1b[2m${g.sessionId}\x1b[0m`)

    const evs = ctx > 0 && eventsBySession ? eventsBySession.get(g.sessionId) : null
    if (evs) {
      // Contexte : voisins ±ctx autour de chaque hit, fenêtres fusionnées, chronologique.
      const hitIdxs = []
      const idxById = new Map(evs.map((e, i) => [e.id, i]))
      for (const h of g.hits) { const i = idxById.get(h.id); if (i != null) hitIdxs.push(i) }
      for (const [a, b] of mergeWindows(evs.length, hitIdxs, ctx)) {
        if (a > 0) lines.push('    ⋯')
        for (let i = a; i <= b; i++) {
          const e = evs[i]
          const hit = hitById.get(e.id)
          lines.push(renderEvent(e, { mark: hit ? '► ' : '  ', hit, plain }))
        }
        if (b < evs.length - 1) lines.push('    ⋯')
      }
    } else {
      for (const h of g.hits) {
        const meta = `\x1b[2m${fmtTs(h.ts)} ${h.role}${h.model ? ` ${h.model}` : ''}${h.agent ? ` (${h.agent})` : ''}\x1b[0m`
        lines.push(`  ${meta}`)
        const snip = h.snip && h.snip.trim() ? h.snip : (h.snipCmd || '')
        for (const l of snip.split('\n').slice(0, 3)) lines.push(`    ${l}`)
        if (h.snipCmd && h.snip && h.snip.trim()) lines.push(`    \x1b[2m$ ${h.snipCmd.split('\n')[0]}\x1b[0m`)
      }
    }
    lines.push('')
  }
  lines.push(`\x1b[2m${hits.length} hit(s), ${groups.length} session(s)\x1b[0m`)
  return lines.join('\n')
}

/** Lecture d'une session (sdig read) : fenêtres avec index positionnels. */
export function renderRead (slice, sessionId) {
  const { ses, events: evs, spans, error } = slice
  const L = []
  const title = ses ? `${ses.title || '(sans titre)'} · ${ses.repo || '—'} · ${fmtTs(ses.tsCreated)}` : sessionId
  L.push(`\x1b[1m── ${title}\x1b[0m  \x1b[2m${sessionId} · ${evs.length} messages\x1b[0m`)
  if (error) L.push(`\x1b[2m${error}\x1b[0m`)
  for (const [a, b] of spans) {
    if (a > 0) L.push('  ⋯')
    for (let i = a; i <= b; i++) {
      const e = evs[i]
      const mark = slice.aroundIdx === i ? '► ' : '  '
      L.push(`${String(i).padStart(3)} ${renderEvent(e, { mark })}`)
    }
    if (b < evs.length - 1) L.push('  ⋯')
  }
  return L.join('\n')
}

/** Section sortie brute (sdig --raw). */
export function renderRawHits (matches) {
  if (!matches.length) return ''
  const L = ['\x1b[1m── sorties brutes correspondantes (raw/)\x1b[0m']
  for (const m of matches) {
    L.push(`  \x1b[2m${fmtTs(m.ts)} ${m.tool || ''} → ${m.sessionId}\x1b[0m`)
    if (m.cmd) L.push(`    \x1b[2m$ ${trunc(m.cmd, 120)}\x1b[0m`)
    L.push(`    ${m.line}`)
    L.push(`    \x1b[2m→ preuve : sdig raw ${m.rawRef} (ligne ${m.lineNo}) · contexte : sdig read ${m.sessionId}\x1b[0m`)
  }
  return L.join('\n')
}

export function renderJson (hits) {
  return JSON.stringify(hits.map(h => ({
    id: h.id,
    sessionId: h.session_id,
    ts: h.ts,
    date: fmtTs(h.ts),
    role: h.role,
    agent: h.agent,
    repo: h.repo,
    model: h.model,
    score: h.score,
    snippet: h.snip,
    cmdSnippet: h.snipCmd,
    cost: h.cost ?? undefined
  })), null, 2)
}

export function renderStatus (st, paths) {
  const L = []
  L.push(`corpus   : ${paths.root}`)
  L.push(`sessions : ${st.counts.sessions}`)
  L.push(`events   : ${st.counts.events}`)
  L.push(`raw      : ${st.rawFiles} fichier(s)`)
  L.push(`watermark: message=${st.watermark.message} session=${st.watermark.session} (${fmtTs(st.watermark.message)})`)
  L.push(`index    : ${st.index ? `${st.index.events} event(s) indexé(s), MAJ ${fmtTs(st.index.mtime)}` : 'absent (lancer sdig index)'}`)
  return L.join('\n')
}

export function renderCostSummary (sessions) {
  // Aperçu v2 (sstats) : coût total par modèle — déjà possible avec le corpus.
  const byModel = new Map()
  for (const s of sessions) {
    const evs = s._events || []
    for (const e of evs) {
      const m = e.model?.modelID || '?'
      const cur = byModel.get(m) || { msgs: 0, cost: 0, tokensIn: 0, tokensOut: 0 }
      cur.msgs++
      cur.cost += e.cost || 0
      cur.tokensIn += e.tokens?.in || 0
      cur.tokensOut += e.tokens?.out || 0
      byModel.set(m, cur)
    }
  }
  const L = ['modèle            msgs      coût      tok in    tok out']
  for (const [m, c] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    L.push(`${m.padEnd(17)} ${String(c.msgs).padStart(5)} ${fmtCost(c.cost).padStart(9)} ${String(c.tokensIn).padStart(9)} ${String(c.tokensOut).padStart(9)}`)
  }
  return L.join('\n')
}
