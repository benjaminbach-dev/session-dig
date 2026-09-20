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

const ANSI_RE = /\x1b\[[0-9;]*m/g
const stripAnsi = s => (s || '').replace(ANSI_RE, '')

/**
 * Longueur « nue » de l'extrait affiché (bug 20/09, retour utilisateur) : la détection
 * de coupure ne doit jamais mesurer le texte décoré. En --plain les marqueurs »…«
 * gonflent la longueur — un extrait coupé pouvait dépasser la longueur du message
 * complet et passer inaperçu. snipPlain (jumeau sans décorations, calculé par le
 * retriever) fait foi et conserve les caractères de la source, dont « ».
 */
function contentLen (displayed, plainTwin) {
  if (plainTwin != null) return plainTwin.length
  return stripAnsi(displayed).replaceAll('»', '').replaceAll('«', '').length
}

function fmtChars (n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * Texte d'un message sous bornes d'affichage (change add-remedy-truncation).
 * Défaut : 400 caractères puis 4 lignes (comportement historique). `--chars N` :
 * budget de caractères explicite, sans limite de lignes. `--full` : intégral.
 * Retourne { lines, cut, shownLen, total } — jamais de coupure silencieuse.
 */
function renderText (text, { full = false, chars = null } = {}) {
  const total = (text || '').length
  if (!text) return { lines: [], cut: false, shownLen: 0, total }
  if (full) return { lines: text.split('\n'), cut: false, shownLen: total, total }
  if (chars != null) {
    const shown = trunc(text, chars)
    return { lines: shown.split('\n'), cut: shown !== text, shownLen: shown.length, total }
  }
  const shown = trunc(text, 400).split('\n').slice(0, 4).join('\n')
  return { lines: shown.split('\n'), cut: shown !== text, shownLen: shown.length, total }
}

/**
 * Marqueur de troncation (change add-remedy-truncation, analyse du 19/09) :
 * une coupure d'affichage silencieuse fait croire que l'archive ne contient
 * pas la suite. Le marqueur donne les compteurs exacts et un chemin qui existe.
 */
function truncMarker ({ shownLen, total, sessionId, msgId, plain = false }) {
  const dim = plain ? '' : '\x1b[2m'
  const reset = plain ? '' : '\x1b[0m'
  return `    ${dim}⚠ message tronqué à l'affichage (${fmtChars(shownLen)}/${fmtChars(total)} caractères) — intégral : sdig read ${sessionId} --around ${msgId} --full (ou --chars N) · sdig search --json${reset}`
}

/** Rendu d'un événement du corpus (voisin de hit ou lecture de session). */
export function renderEvent (e, { mark = '  ', hit = null, plain = false, full = false, chars = null } = {}) {
  const dim = plain ? '' : '\x1b[2m'
  const reset = plain ? '' : '\x1b[0m'
  const model = e.model && (e.model.providerID || e.model.modelID) ? `${e.model.providerID || ''}/${e.model.modelID || ''}` : ''
  const L = []
  const head = `${mark}${dim}${fmtTs(e.ts)} ${e.role}${model ? ` ${model}` : ''}${e.agent ? ` (${e.agent})` : ''}${e.cost ? ` ${fmtCost(e.cost)}` : ''}${reset}`
  L.push(head)
  if (!full && chars == null && hit && hit.snip && hit.snip.trim()) {
    for (const l of hit.snip.split('\n').slice(0, 3)) L.push(`    ${l}`)
    // extrait de recherche plus court que le message → marqueur (id de session ≠ id de message : pas les lignes synthétiques de titre)
    if (e.text && e.id !== e.sessionId) {
      const shownLen = contentLen(hit.snip.split('\n').slice(0, 3).join('\n'), hit.snipPlain != null ? hit.snipPlain.split('\n').slice(0, 3).join('\n') : null)
      if (shownLen < e.text.length) L.push(truncMarker({ shownLen, total: e.text.length, sessionId: e.sessionId, msgId: e.id, plain }))
    }
  } else if (e.text) {
    const r = renderText(e.text, { full, chars })
    for (const l of r.lines) L.push(`    ${l}`)
    if (r.cut) L.push(truncMarker({ shownLen: r.shownLen, total: r.total, sessionId: e.sessionId, msgId: e.id, plain }))
  }
  for (const c of e.toolCalls || []) {
    const ec = c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''
    const raw = c.rawRef ? ` → sdig raw ${c.rawRef}` : ''
    L.push(`    ${dim}· ${c.tool}: ${trunc(c.cmd || '', 120)}${ec}${raw}${reset}`)
  }
  return L.join('\n')
}

export function renderTerminal (hits, sessionsById, opts = {}) {
  // Deux sources de contexte (change scale-corpus) :
  //  - ctxBySession : Map sessionId → { total, evs, absIdx } (fenêtre DENSE, rangs
  //    absolus) issu des requêtes bornées de la vue (chemin de commande, CLI) ;
  //  - eventsBySession : Map sessionId → events complets (tests à échelle minuscule).
  const { ctx = 0, ctxBySession = null, eventsBySession = null, plain = false, full = false, chars = null } = opts
  const dim = plain ? '' : '\x1b[2m'
  const groups = groupBySession(hits)
  const lines = []
  const hitById = new Map(hits.map(h => [h.id, h]))

  for (const g of groups) {
    const ses = sessionsById.get(g.sessionId)
    const head = ses
      ? `── ${ses.title || '(sans titre)'} · ${ses.repo || '—'} · ${fmtTs(ses.tsCreated)}`
      : `── session ${g.sessionId}`
    lines.push(`\x1b[1m${head}\x1b[0m  \x1b[2m${g.sessionId}\x1b[0m`)

    const win = ctx > 0 && ctxBySession ? ctxBySession.get(g.sessionId) : null
    const evs = win ? win.evs : (ctx > 0 && eventsBySession ? eventsBySession.get(g.sessionId) : null)
    if (evs) {
      if (win) {
        // Fenêtre DENSE (passe corrective 20/09) : voisins ±ctx par CLÉ autour de
        // chaque hit, rangs absolus connus (absIdx) — marqueurs d'écart exacts,
        // mémoire O(fenêtres), jamais O(taille de la session).
        const total = win.total ?? evs.length
        const absIdx = win.absIdx || evs.map((_, i) => i)
        if (absIdx[0] > 0) lines.push('    ⋯')
        for (let i = 0; i < evs.length; i++) {
          if (i > 0 && absIdx[i] !== absIdx[i - 1] + 1) lines.push('    ⋯')
          const hit = hitById.get(evs[i].id)
          lines.push(renderEvent(evs[i], { mark: hit ? '► ' : '  ', hit, plain, full, chars }))
        }
        if (absIdx[evs.length - 1] < total - 1) lines.push('    ⋯')
      } else {
        // Contexte hérité (tests à échelle minuscule) : fenêtre = session entière.
        const hitIdxs = []
        const idxById = new Map(evs.map((e, i) => [e.id, i]))
        for (const h of g.hits) { const i = idxById.get(h.id); if (i != null) hitIdxs.push(i) }
        for (const [a, b] of mergeWindows(evs.length, hitIdxs, ctx)) {
          if (a > 0) lines.push('    ⋯')
          for (let i = a; i <= b; i++) {
            const e = evs[i]
            if (!e) continue
            const hit = hitById.get(e.id)
            lines.push(renderEvent(e, { mark: hit ? '► ' : '  ', hit, plain, full, chars }))
          }
          if (b < evs.length - 1) lines.push('    ⋯')
        }
      }
    } else {
      for (const h of g.hits) {
        const meta = `\x1b[2m${fmtTs(h.ts)} ${h.role}${h.model ? ` ${h.model}` : ''}${h.agent ? ` (${h.agent})` : ''}\x1b[0m`
        lines.push(`  ${meta}`)
        if (full || chars != null) {
          // bornes explicites : texte du message (le champ text est intégral depuis l'index)
          const r = renderText(h.text || '', { full, chars })
          for (const l of r.lines) lines.push(`    ${l}`)
          if (r.cut && h.id !== h.session_id) lines.push(truncMarker({ shownLen: r.shownLen, total: r.total, sessionId: h.session_id, msgId: h.id, plain }))
          if (h.snipCmd && h.snipCmd.trim()) lines.push(`    ${dim}$ ${h.snipCmd.split('\n')[0]}${reset0(plain)}`)
        } else {
          const snip = h.snip && h.snip.trim() ? h.snip : (h.snipCmd || '')
          for (const l of snip.split('\n').slice(0, 3)) lines.push(`    ${l}`)
          if (h.snipCmd && h.snip && h.snip.trim()) lines.push(`    ${dim}$ ${h.snipCmd.split('\n')[0]}${reset0(plain)}`)
          // extrait de recherche plus court que le message → marqueur (jamais de coupure silencieuse)
          if (h.text && h.snip && h.snip.trim() && h.id !== h.session_id) {
            const shownLen = contentLen(snip.split('\n').slice(0, 3).join('\n'), h.snipPlain != null ? h.snipPlain.split('\n').slice(0, 3).join('\n') : null)
            if (shownLen < h.text.length) lines.push(truncMarker({ shownLen, total: h.text.length, sessionId: h.session_id, msgId: h.id, plain }))
          }
        }
      }
    }
    lines.push('')
  }
  lines.push(`\x1b[2m${hits.length} hit(s), ${groups.length} session(s)\x1b[0m`)
  return lines.join('\n')
}

function reset0 (plain) { return plain ? '' : '\x1b[0m' }

/**
 * Lecture d'une session (sdig read) : fenêtres avec index positionnels.
 * Change add-read-at : deux marqueurs distincts, jamais confondus —
 *   - « ancre : … » en tête quand la lecture est bornée dans le temps ;
 *   - « … N message(s) … masqué(s) » en fin de vue (masquage temporel) ;
 *   - le marqueur de troncature reste par message (coupure d'affichage).
 */
export function renderRead (slice, sessionId, opts = {}) {
  const { full = false, chars = null, plain = false } = opts
  const { ses, events: evs, spans, error, anchor = null, maskedCount = 0 } = slice
  const last = slice.maxIdx == null ? evs.length - 1 : slice.maxIdx
  const dim = plain ? '' : '\x1b[2m'
  const reset = plain ? '' : '\x1b[0m'
  const L = []
  const title = ses ? `${ses.title || '(sans titre)'} · ${ses.repo || '—'} · ${fmtTs(ses.tsCreated)}` : sessionId
  L.push(`\x1b[1m── ${title}\x1b[0m  \x1b[2m${sessionId} · ${slice.total ?? evs.length} messages${anchor ? ` (${last + 1} visibles)` : ''}\x1b[0m`)
  if (anchor) L.push(`${dim}ancre : ${anchor.id ? `${anchor.id} ` : ''}(${anchor.date}) — lecture bornée à cet instant, ancre incluse${reset}`)
  if (error) L.push(`${dim}${error}${reset}`)
  for (const [a, b] of spans) {
    if (a > 0) L.push('  ⋯')
    for (let i = a; i <= b; i++) {
      const e = evs[i - a] ?? evs[i] // fenêtres partielles : les events suivent les spans
      if (!e) continue
      const mark = slice.aroundIdx === i ? '► ' : '  '
      L.push(`${String(i).padStart(3)} ${renderEvent(e, { mark, full, chars, plain })}`)
    }
    if (b < last) L.push('  ⋯')
  }
  if (maskedCount > 0) {
    L.push(`${dim}… ${maskedCount} message(s) postérieur(s) à l'ancre masqué(s) — relire sans --at pour voir la session entière${reset}`)
  }
  return L.join('\n')
}

/** Lecture bornée en JSON (change add-read-at) : ancre résolue + compte masqué + textes intégraux. */
export function renderReadJson (slice, sessionId) {
  const { ses, events: evs, spans, anchor = null, maskedCount = 0, error = null } = slice
  const last = slice.maxIdx == null ? evs.length - 1 : slice.maxIdx
  const idxs = []
  for (const [a, b] of spans) for (let i = a; i <= b; i++) idxs.push(i)
  const evById = new Map(evs.map(e => [e.id, e]))
  return JSON.stringify({
    sessionId,
    title: ses?.title ?? null,
    repo: ses?.repo ?? null,
    anchor,
    maskedCount,
    visible: Math.max(0, last + 1),
    total: slice.total ?? evs.length,
    error: error ?? undefined,
    messages: idxs.map(i => {
      const e = evById.get(idOfIndex(slice, i)) || evs[idxs.indexOf(i)]
      if (!e) return null
      return {
        index: i,
        id: e.id,
        ts: e.ts,
        date: fmtTs(e.ts),
        role: e.role,
        agent: e.agent ?? null,
        model: e.model ?? null,
        text: e.text ?? null,
        toolCalls: e.toolCalls ?? []
      }
    }).filter(Boolean)
  }, null, 2)
}

// index positionnel → id (spans partiels : la fenêtre n'est pas chargée en entier)
function idOfIndex (slice, i) {
  return slice.indexIds?.[i] ?? null
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
    text: h.text ?? undefined,
    cost: h.cost ?? undefined
  })), null, 2)
}

export function renderStatus (st, paths) {
  const L = []
  L.push(`corpus   : ${paths.root}`)
  L.push(`layout   : v${st.layout ?? 2}`)
  L.push(`sessions : ${st.counts.sessions}`)
  L.push(`events   : ${st.counts.events}`)
  L.push(`raw      : ${st.rawFiles} fichier(s)`)
  L.push(`watermark: message=${st.watermark.message} session=${st.watermark.session} (${fmtTs(st.watermark.message)})`)
  L.push(`vue      : ${st.view ? `${st.view.events} event(s) en vue, MAJ ${fmtTs(st.view.mtime)}` : 'absente (lancer sdig refresh)'}`)
  return L.join('\n')
}

/** Empreinte du corpus (sdig fingerprint) : valeur, taille, md5 par fichier. */
export function renderFingerprint (f) {
  const fmtBytes = n => n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} Mo` : n > 1024 ? `${(n / 1024).toFixed(1)} Ko` : `${n} o`
  const L = []
  L.push(`empreinte : ${f.fingerprint}  (${f.files.length} fichier(s), ${fmtBytes(f.bytes)})`)
  for (const fl of f.files) L.push(`  ${fl.md5}  ${fl.file}`)
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
