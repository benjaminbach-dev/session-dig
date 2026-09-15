// Affichage : hits regroupés par session (décision d'affichage, l'index reste au grain message).
import { fmtTs, fmtCost } from './util.js'

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

export function renderTerminal (hits, sessionsById) {
  const groups = groupBySession(hits)
  const lines = []
  for (const g of groups) {
    const ses = sessionsById.get(g.sessionId)
    const head = ses
      ? `── ${ses.title || '(sans titre)'} · ${ses.repo || '—'} · ${fmtTs(ses.tsCreated)}`
      : `── session ${g.sessionId}`
    lines.push(`\x1b[1m${head}\x1b[0m  \x1b[2m${g.sessionId}\x1b[0m`)
    for (const h of g.hits) {
      const meta = `\x1b[2m${fmtTs(h.ts)} ${h.role}${h.model ? ` ${h.model}` : ''}${h.agent ? ` (${h.agent})` : ''}\x1b[0m`
      lines.push(`  ${meta}`)
      const snip = h.snip && h.snip.trim() ? h.snip : (h.snipCmd || '')
      for (const l of snip.split('\n').slice(0, 3)) lines.push(`    ${l}`)
      if (h.snipCmd && h.snip && h.snip.trim()) lines.push(`    \x1b[2m$ ${h.snipCmd.split('\n')[0]}\x1b[0m`)
    }
    lines.push('')
  }
  lines.push(`\x1b[2m${hits.length} hit(s), ${groups.length} session(s)\x1b[0m`)
  return lines.join('\n')
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
