// Audit déterministe des accès d'un run d'examen (change update-natural-eval).
//
// Rôle : filet de détection a posteriori, PAS une garantie d'exclusivité d'accès.
// Il scanne les appels d'outils enregistrés d'une exécution (un JSON par réponse,
// champ `toolCalls`) et liste, par question, les commandes qui touchent directement
// l'archive : fichiers du corpus (events.jsonl, sessions.jsonl, raw/), bases sources
// (opencode.db, index.db), invocations sqlite, `sdig ingest|refresh`, et la lecture
// des fichiers du jeu de test (qui invalide l'exécution).
//
// Deux principes, appris des runs réels :
//
//  1. On n'analyse QUE la commande réellement invoquée, pas la présence d'un mot.
//     Chaque segment est découpé en commande + arguments + redirections ; quand la
//     commande est `sdig`, seule une sous-commande non légitime (ingest, refresh)
//     ou une redirection/argument pointant un fichier de l'archive est une
//     déviation — `sdig search "ingest"` reste une recherche légitime, tandis que
//     `grep sdig events.jsonl` (commandes `grep`) est une lecture directe.
//     Les formes indécidables (commande dynamique, substitution, xargs) sont
//     marquées « à examiner » plutôt que déclarées propres ou coupables.
//  2. Une entrée qu'on ne sait pas lire n'est pas une entrée propre : les JSON
//     illisibles et les appels sans commande extractible sont comptés, listés et
//     font basculer le rapport en « audit incomplet » (sortie non nulle en --strict).
//
// La liste des motifs est ÉPINGLÉE ici (MOTIFS, gelée) : toute évolution passe par
// un commit, et l'empreinte des motifs est imprimée dans le rapport pour que deux
// audits soient comparables.
//
// Usage :
//   node scripts/audit-toolcalls.mjs <dossier-de-run>            # markdown sur stdout
//   node scripts/audit-toolcalls.mjs <dossier> --json            # résultat machine
//   node scripts/audit-toolcalls.mjs <dossier> --out audit.md    # écrit dans un fichier
//   node scripts/audit-toolcalls.mjs <dossier> --motifs          # imprime les motifs épinglés
//   node scripts/audit-toolcalls.mjs <dossier> --strict          # exit 1 si déviation ou audit incomplet
//
// Codes de sortie : 0 = audit rendu (même avec déviations), 1 = déviation(s) ou audit
// incomplet avec --strict, 2 = entrée invalide (dossier absent, aucun JSON).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

// --- Motifs épinglés (gelés) -------------------------------------------------

export const MOTIFS = Object.freeze([
  { id: 'opencode-db', label: 'base source opencode.db', re: /opencode\.db/i },
  { id: 'index-db', label: "index d'archive (index.db)", re: /\bindex\.db\b/i },
  { id: 'sqlite', label: 'invocation sqlite', re: /\bsqlite3?\b/i, notAfterQuote: true },
  { id: 'corpus-events', label: 'events.jsonl (corpus)', re: /events\.jsonl/i },
  { id: 'corpus-sessions', label: 'sessions.jsonl (corpus)', re: /sessions\.jsonl/i },
  { id: 'corpus-root', label: 'chemin du corpus', re: /SESSION_DIG_HOME|\.local\/share\/session-dig|session-dig\/(?:corpus|index|raw)\b/i },
  // Écriture du corpus : détectée par RECONNAISSANCE DE LA SOUS-COMMANDE sdig
  // (`ingest`/`refresh` en position de sous-commande), jamais par présence du mot —
  // `sdig search "ingest"` est une recherche, pas une écriture.
  { id: 'sdig-mutation', label: 'sdig ingest/refresh (écriture du corpus)', from: 'invocation' },
  // Lecture du jeu de test : n'est pas une déviation d'accès à l'archive mais
  // invalide l'exécution (spec natural-eval, « Conditions d'exécution du test »).
  { id: 'playbook', label: 'fichiers du jeu de test (exécution invalide)', re: /questions\.jsonl|questions\.md|curated\.json|\bsample-review\b|eval\/natural/i, invalidating: true }
])

/** Empreinte stable de la liste épinglée : deux audits ne se comparent que si elle coïncide. */
export const MOTIFS_FINGERPRINT = crypto
  .createHash('sha256')
  .update(MOTIFS.map(m => `${m.id}:${m.re ? m.re.source + m.re.flags : 'invocation'}`).join('\n'))
  .digest('hex')
  .slice(0, 16)

const MUTATING_SUBCOMMANDS = new Set(['ingest', 'refresh'])

// Commandes qui en préfixent une autre : on continue la recherche après elles.
const PREFIX_COMMANDS = new Set(['sudo', 'env', 'time', 'command', 'exec', 'nohup', 'nice', 'stdbuf'])
// Mots-clés de contrôle shell : pas de commande invoquée (entête de boucle, bloc…).
const SHELL_KEYWORDS = new Set(['for', 'do', 'done', 'then', 'else', 'elif', 'fi', 'if', 'while', 'until', 'case', 'esac', 'in', '{', '}', '(', ')', '!', '&&', '||'])
// Commandes dont l'action réelle est indécidable sans interpréter le shell.
const DYNAMIC_COMMANDS = new Set(['eval', 'xargs', 'source', '.'])
// Options de sdig qui consomment la valeur suivante (pour ne pas la confondre avec
// une sous-commande ou un chemin lu en argument positionnel).
const VALUE_FLAGS = new Set(['--corpus', '--limit', '--repo', '--session', '--after', '--before', '--model', '--role', '--agent', '--ctx', '--tail', '--chars', '--n', '--seed', '--file', '--out', '--at'])

// --- Extraction du texte d'un appel d'outil ----------------------------------

/**
 * Texte « utile » d'un appel d'outil : la commande bash, le chemin lu, le motif
 * cherché… `input` est un JSON encodé en chaîne (état d'outil opencode), mais on
 * reste tolérant (chaîne brute, objet direct, JSON invalide).
 */
export function extractTarget (call) {
  if (call === null || call === undefined) return { text: '', source: 'empty' }
  const raw = typeof call?.input === 'string' ? call.input : JSON.stringify(call?.input ?? '')
  if (!raw || raw === '""') return { text: '', source: 'empty' }
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { /* état tronqué : on extrait le champ à la main */ }
  const inner = parsed && typeof parsed === 'object'
    ? (parsed.input && typeof parsed.input === 'object' ? parsed.input : parsed.args && typeof parsed.args === 'object' ? parsed.args : null)
    : null
  if (inner) {
    for (const k of ['command', 'cmd', 'script', 'code', 'filePath', 'file', 'path', 'pattern', 'query', 'url', 'content']) {
      if (typeof inner[k] === 'string' && inner[k]) return { text: inner[k], source: 'field:' + k }
    }
  }
  if (typeof parsed === 'string' && parsed) return { text: parsed, source: 'json-string' }
  if (parsed && typeof parsed === 'object') {
    const salvage = commandFromRaw(raw)
    return { text: salvage ?? '', source: salvage ? 'json-salvage' : 'json-sans-champ' }
  }
  // Chaîne brute : si elle ressemble à un état JSON (tronqué), on n'en garde que le
  // champ de commande — jamais le bloc entier, dont la sortie d'outil peut citer
  // légitimement un chemin du corpus (« sdig status » imprime le répertoire).
  if (/^\s*[{[]/.test(raw)) {
    const salvage = commandFromRaw(raw)
    return { text: salvage ?? '', source: salvage ? 'salvage' : 'json-sans-champ' }
  }
  return { text: raw, source: 'raw' }
}

/**
 * Récupère `"command": "…"` dans un état d'outil même si le JSON est tronqué
 * (les états enregistrés le sont : la coupure casse `JSON.parse`). Renvoie null
 * si aucun champ de commande n'est trouvé — on préfère ne rien analyser plutôt
 * que d'analyser un bloc de sortie d'outil (faux positifs).
 */
export function commandFromRaw (raw) {
  const m = /"(command|cmd|script|code|filePath|file|path|pattern|query)"\s*:\s*"/.exec(String(raw))
  if (!m) return null
  let out = ''
  for (let i = m.index + m[0].length; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\') {
      const n = raw[++i]
      if (n === undefined) break
      out += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' })[n] ?? n
      continue
    }
    if (c === '"') break
    out += c
  }
  return out.trim() || null
}

// --- Découpage, tokens, masquage ---------------------------------------------

/** Découpe une ligne de commande en segments (pipelines, enchaînements, sous-shells). */
export function segments (command) {
  return String(command)
    .split(/\|\||&&|[|;\n]|\$\(/)
    .map(s => s.replace(/\)\s*$/, '').trim())
    .filter(Boolean)
}

/** Tokens d'un segment : `{ text, quoted, start, end }`, guillemets résolus. */
export function tokenize (seg) {
  const out = []
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (/\s/.test(c) || '(){}'.includes(c)) { i++; continue }
    let text = ''
    let quoted = false
    const start = i
    while (i < seg.length && !/[\s(){}]/.test(seg[i])) {
      const d = seg[i]
      if (d === '"' || d === "'") {
        quoted = true
        const end = seg.indexOf(d, i + 1)
        text += end === -1 ? seg.slice(i + 1) : seg.slice(i + 1, end)
        i = end === -1 ? seg.length : end + 1
        continue
      }
      if (d === '\\' && i + 1 < seg.length) { text += seg[i + 1]; i += 2; continue }
      text += d
      i++
    }
    out.push({ text, quoted, start, end: i })
  }
  return out
}

/**
 * Masque les citations qui ressemblent à des phrases (guillemets + espaces, sans
 * ponctuation de code) : arguments de requête, motifs de grep. Sans ce masque,
 * `for q in "sqlite leur" …` serait signalé comme invocation sqlite.
 * Un corps de script entre guillemets (`node -e "const D=require(...)"`) contient
 * de la ponctuation de code : il est conservé, sinon on raterait de vrais accès.
 */
export function maskQuotedPhrases (text) {
  const s = String(text)
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c !== '"' && c !== "'") { out += c; i++; continue }
    const end = s.indexOf(c, i + 1)
    const span = end === -1 ? s.slice(i) : s.slice(i, end + 1)
    out += isPhraseLike(span) ? '«phr»' : span
    if (end === -1) break // citation non fermée (état tronqué) : fin de segment
    i = end + 1
  }
  return out
}

function isPhraseLike (span) {
  return /\s/.test(span) && !/[=(){};|<>$`]|\b(?:import|require|from|def|open|connect)\b/.test(span)
}

/** Redirections d'un segment : `{ op, target }` (les duplications de fd sont ignorées). */
export function redirections (seg) {
  const out = []
  const re = /(\d*)(>>|>|<|<<)\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s|;&()<>]+)/g
  let m
  while ((m = re.exec(seg)) !== null) {
    const target = m[3].replace(/^["']|["']$/g, '')
    if (!target || target.startsWith('&') || /^\d+$/.test(target)) continue // fd dup : 2>&1
    out.push({ op: m[2], target })
  }
  return out
}

/** Nom de base d'un chemin de commande (`/usr/local/bin/sdig` → `sdig`). */
function basename (p) { return String(p).replace(/^['"]|['"]$/g, '').split('/').pop() }

/**
 * Reconnaît la commande réellement invoquée d'un segment : son binaire, sa
 * sous-commande si c'est `sdig`, ses redirections et les chemins passés en
 * argument positionnel (hors valeurs d'options). `kind` vaut :
 *   `command`  — binaire identifié ;
 *   `keyword`  — entête/bloc shell, assignation (aucune commande) ;
 *   `dynamic`  — action indécidable (substitution, eval, xargs, `$CMD`) → « à examiner ».
 */
export function parseSegment (seg) {
  const toks = tokenize(seg)
  const reds = redirections(seg)
  let i = 0
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i].text) && !toks[i].quoted) i++ // VAR=valeur
  while (i < toks.length && PREFIX_COMMANDS.has(basename(toks[i].text))) i++
  const head = toks[i]
  if (!head || head.quoted || SHELL_KEYWORDS.has(head.text)) {
    return { kind: 'keyword', bin: null, subcommand: null, flagValues: [], positionalPaths: [], redirections: reds, raw: seg }
  }
  if (DYNAMIC_COMMANDS.has(head.text) || /^[$`{]/.test(head.text)) {
    return { kind: 'dynamic', bin: head.text, subcommand: null, flagValues: [], positionalPaths: [], redirections: reds, raw: seg }
  }
  const bin = basename(head.text)
  const rest = toks.slice(i + 1)
  let subcommand = null
  let quotedSub = false
  const flagValues = []
  const positionalPaths = []
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j]
    const eq = /^(--[a-z-]+)=(.*)$/.exec(t.text)
    if (eq) {
      if (VALUE_FLAGS.has(eq[1])) flagValues.push(eq[2])
      continue
    }
    if (t.text.startsWith('-')) {
      if (VALUE_FLAGS.has(t.text) && rest[j + 1]) { flagValues.push(rest[j + 1].text); j++ }
      continue
    }
    if (subcommand === null && bin === 'sdig') { subcommand = t.text; quotedSub = t.quoted; continue }
    if (/[/\\]/.test(t.text) || /\.(?:jsonl|json|db)\b/i.test(t.text)) positionalPaths.push(t.text)
  }
  return { kind: 'command', bin, subcommand, quotedSub, flagValues, positionalPaths, redirections: reds, raw: seg }
}

// --- Appariement -------------------------------------------------------------

function window (text, idx, len) {
  const start = Math.max(0, idx - 60)
  const end = Math.min(text.length, idx + len + 60)
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '')
}

function hitIn (text, motif) {
  const re = new RegExp(motif.re.source, motif.re.flags.includes('g') ? motif.re.flags : motif.re.flags + 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    // `notAfterQuote` : un mot-clé collé à une citation ouvrante (`"SQLite`, reste
    // d'un état tronqué) est du texte cité, pas une invocation de commande.
    if (motif.notAfterQuote && /['"]/.test(text[m.index - 1] ?? '')) {
      re.lastIndex = m.index + 1
      continue
    }
    return { motif: motif.id, label: motif.label, invalidating: !!motif.invalidating, excerpt: window(text, m.index, m[0].length) }
  }
  return null
}

/**
 * Analyse une commande : déviations d'accès (`hits`) et segments à examiner
 * (`review`, action indécidable). Les motifs textuels ne s'appliquent qu'aux
 * segments dont la commande n'est pas un `sdig` légitime ; pour un `sdig`
 * légitime, seules les redirections et les chemins en argument sont regardés.
 */
export function analyseCommand (command) {
  const text = String(command ?? '')
  const hits = []
  const review = []
  if (!text.trim()) return { hits, review }
  const push = (list, h) => { if (h && !list.some(o => o.motif === h.motif && o.excerpt === h.excerpt)) list.push(h) }
  // Substitution de commande : le découpage en segments masque le « $( », mais
  // l'action réelle reste indécidable → « à examiner » (les motifs restent testés).
  if (/\$\(|`/.test(text)) {
    review.push({ reason: 'substitution de commande (action partiellement indécidable)', excerpt: window(maskQuotedPhrases(text), Math.max(0, text.search(/\$\(|`/) - 30), 60) })
  }
  for (const seg of segments(text)) {
    const p = parseSegment(seg)
    const masked = maskQuotedPhrases(seg)
    if (p.kind === 'dynamic') {
      review.push({ reason: p.bin === 'xargs' || p.bin === 'eval' ? `commande dynamique (${p.bin})` : 'commande indécidable (substitution/variable)', excerpt: window(masked, 0, Math.min(masked.length, 60)) })
    }
    const sdigLegit = p.kind === 'command' && p.bin === 'sdig' && !(p.subcommand && !p.quotedSub && MUTATING_SUBCOMMANDS.has(p.subcommand))
    if (p.kind === 'command' && p.bin === 'sdig' && p.subcommand && !p.quotedSub && MUTATING_SUBCOMMANDS.has(p.subcommand)) {
      push(hits, { motif: 'sdig-mutation', label: 'sdig ingest/refresh (écriture du corpus)', invalidating: false, excerpt: window(masked, 0, Math.min(masked.length, 80)) })
    }
    // Cibles à tester : le segment entier pour une commande ordinaire, sinon les
    // seules redirections et chemins passés en argument à sdig.
    const targets = sdigLegit ? [...p.redirections.map(r => r.target), ...p.positionalPaths] : [masked]
    for (const t of targets) {
      for (const m of MOTIFS) {
        if (m.from === 'invocation') continue
        if (sdigLegit && m.invalidating) continue // le jeu de test cité en argument de sdig n'est pas une lecture
        push(hits, hitIn(maskQuotedPhrases(t), m))
      }
    }
    if (sdigLegit && p.flagValues.some(v => /[/\\]/.test(v))) {
      review.push({ reason: 'option sdig pointant un chemin explicite', excerpt: window(masked, 0, Math.min(masked.length, 80)) })
    }
  }
  return { hits, review }
}

/** Motifs textuels déclenchés par une commande (vue simplifiée, pour les tests). */
export function matchMotifs (command) {
  return analyseCommand(command).hits
}

// --- Audit -------------------------------------------------------------------

function answerSummary (answer, max = 140) {
  const flat = String(answer ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return '(pas de réponse)'
  return flat.length > max ? '…' + flat.slice(-max) : flat
}

function questionShort (q, max = 70) {
  const flat = String(q ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/** Audite une liste de réponses d'examen (objets `{id, question, answer, toolCalls, recovered}`). */
export function auditResponses (responses, { label = 'run' } = {}) {
  const deviations = []
  const review = []
  const unanalysable = []
  const unreadable = []
  let scanned = 0
  let recovered = 0
  let calls = 0
  responses.forEach((entry, entryIndex) => {
    const r = entry?.__unreadable ? entry : entry
    if (entry?.__unreadable) { unreadable.push({ file: entry.file, reason: entry.reason }); return }
    if (!r || typeof r !== 'object' || !r.id) { unreadable.push({ file: entry?.__file ?? `#${entryIndex}`, reason: 'entrée sans identifiant de question' }); return }
    scanned++
    if (r.recovered) recovered++
    const toolCalls = Array.isArray(r.toolCalls) ? r.toolCalls : []
    toolCalls.forEach((call, index) => {
      calls++
      const { text } = extractTarget(call)
      if (!text) {
        unanalysable.push({ id: r.id, callIndex: index, tool: call?.tool ?? '?', reason: 'appel sans commande extractible' })
        return
      }
      const { hits, review: notes } = analyseCommand(text)
      const context = { id: r.id, callIndex: index, tool: call?.tool ?? '?', question: questionShort(r.question), command: text.replace(/\s+/g, ' ').slice(0, 300) }
      if (hits.length) {
        deviations.push({
          ...context,
          motifs: hits.map(h => h.motif),
          label: hits.map(h => h.label).join(' ; '),
          invalidating: hits.some(h => h.invalidating),
          excerpt: [...new Set(hits.map(h => h.excerpt))].slice(0, 3).join(' ⏵ '),
          summary: answerSummary(r.answer)
        })
      }
      for (const n of notes) {
        review.push({ ...context, reason: n.reason, excerpt: n.excerpt, summary: answerSummary(r.answer, 80) })
      }
    })
  })
  const motifCounts = {}
  for (const d of deviations) for (const m of d.motifs) motifCounts[m] = (motifCounts[m] ?? 0) + 1
  return {
    label,
    audit: "audit a posteriori (filet de détection, pas une garantie d'exclusivité d'accès)",
    motifsFingerprint: MOTIFS_FINGERPRINT,
    motifs: MOTIFS.map(m => m.id),
    scanned,
    recovered,
    calls,
    status: (unreadable.length || unanalysable.length) ? 'incomplete' : 'complete',
    unreadable,
    unanalysable,
    deviations,
    review,
    invalidating: deviations.filter(d => d.invalidating).length,
    motifCounts,
    questions: [...new Set(deviations.map(d => d.id))].sort()
  }
}

/** Audite un dossier de run (un JSON par réponse ; `manifest.json` ignoré). */
export function auditDir (dir, opts = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`dossier introuvable : ${dir}`)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'manifest.json').sort()
  if (!files.length) throw new Error(`aucun JSON de réponse dans ${dir}`)
  const responses = files.map(f => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { __unreadable: true, file: f, reason: 'JSON valide mais pas un objet de réponse' }
      return { ...parsed, __file: f }
    } catch (e) {
      return { __unreadable: true, file: f, reason: `JSON illisible (${e.message})` }
    }
  })
  const result = auditResponses(responses, { label: opts.label ?? path.basename(dir) })
  result.dir = dir
  result.files = files
  result.responses = files.length
  return result
}

// --- Rendu -------------------------------------------------------------------

function cell (s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() }

/** Rapport markdown : conditions, tableau des déviations, à examiner, motifs épinglés. */
export function renderMarkdown (result) {
  const L = []
  L.push(`# Audit des accès — ${result.label}`)
  L.push('')
  if (result.dir) L.push(`- Dossier : \`${result.dir}\``)
  L.push(`- Réponses scannées : **${result.scanned}**${result.responses && result.responses !== result.scanned ? ` (sur ${result.responses} fichier(s))` : ''}${result.recovered ? ` — dont ${result.recovered} récupérées \`recovered\`` : ''}`)
  L.push(`- Appels d'outils analysés : **${result.calls ?? 0}** · **${result.unreadable.length}** entrée(s) illisible(s) · **${result.unanalysable.length}** appel(s) non analysable(s) · **${result.review.length}** segment(s) à examiner`)
  L.push(`- Motifs épinglés : **${result.motifs.length}** — empreinte \`${result.motifsFingerprint}\``)
  L.push(`- Nature : ${result.audit}`)
  L.push(`- Statut : ${result.status === 'complete' ? '**audit complet** (toutes les entrées ont pu être analysées)' : '⚠️ **AUDIT INCOMPLET** (voir entrées illisibles / appels non analysables ci-dessous)'}`)
  L.push('')
  if (!result.deviations.length) {
    L.push('**Aucune déviation détectée.** — rien de détecté n\'est pas la preuve que rien n\'a eu lieu : le filet')
    L.push("détecte les accès directs reconnaissables, il ne garantit pas l'exclusivité d'accès à l'archive.")
  } else {
    L.push(`**${result.deviations.length} commande(s) en déviation d'accès** sur ${result.questions.length} question(s)` +
      (result.invalidating ? `, dont **${result.invalidating} invalidante(s)** (lecture du jeu de test)` : '') + ' :')
    L.push('')
    L.push('| question | outil | motif(s) | extrait de commande | résumé final de la réponse |')
    L.push('|---|---|---|---|---|')
    for (const d of result.deviations) {
      L.push(`| ${cell(d.id)} | ${cell(d.tool)} | ${cell(d.motifs.join(' + '))}${d.invalidating ? ' ⚠' : ''} | \`${cell(d.excerpt)}\` | ${cell(d.summary)} |`)
    }
    L.push('')
    L.push('Comptes par motif : ' + Object.entries(result.motifCounts).map(([k, v]) => `${k}=${v}`).join(', '))
    L.push('')
    L.push('Qualification de gravité : décision humaine, écrite dans le rapport (le script liste les faits).')
  }
  if (result.unreadable.length || result.unanalysable.length) {
    L.push('')
    L.push('## Entrées non analysables (audit incomplet)')
    L.push('')
    L.push('| fichier | question | appel | raison |')
    L.push('|---|---|---|---|')
    for (const u of result.unreadable) L.push(`| ${cell(u.file)} | — | — | ${cell(u.reason)} |`)
    for (const u of result.unanalysable) L.push(`| ${cell(u.id)} | ${cell(u.id)} | #${u.callIndex} (${cell(u.tool)}) | ${cell(u.reason)} |`)
    L.push('')
    L.push('Aucune conclusion d\'intégrité ne peut être tirée de ces entrées : elles sont à relire à la main.')
  }
  if (result.review.length) {
    L.push('')
    L.push('## À examiner (action indécidable, ni propre ni coupable)')
    L.push('')
    L.push('| question | outil | raison | extrait |')
    L.push('|---|---|---|---|')
    for (const r of result.review) L.push(`| ${cell(r.id)} | ${cell(r.tool)} | ${cell(r.reason)} | \`${cell(r.excerpt)}\` |`)
    L.push('')
    L.push('Ces segments ne sont pas des déviations prouvées : l\'audit ne sait pas décider quelle commande est invoquée.')
  }
  L.push('')
  L.push('## Motifs épinglés')
  L.push('')
  L.push('| motif | description |')
  L.push('|---|---|')
  for (const m of MOTIFS) L.push(`| ${m.id} | ${m.label}${m.from === 'invocation' ? ' — détecté par reconnaissance de la sous-commande' : ''}${m.invalidating ? ' — invalide l\'exécution' : ''} |`)
  L.push('')
  return L.join('\n')
}

// --- CLI ---------------------------------------------------------------------

function main (argv) {
  const opts = { label: null, out: null, strict: false, json: false, motifs: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--label' || a === '--out') { opts[a.slice(2)] = argv[++i] ?? null; continue }
    if (a === '--strict') { opts.strict = true; continue }
    if (a === '--json') { opts.json = true; continue }
    if (a === '--motifs') { opts.motifs = true; continue }
    if (a.startsWith('-')) { console.error(`option inconnue : ${a}`); return 2 }
    positional.push(a)
  }
  if (opts.motifs) {
    for (const m of MOTIFS) console.log(`${m.id.padEnd(16)} ${m.label}${m.invalidating ? " [invalide l'exécution]" : ''}`)
    console.log(`\nempreinte : ${MOTIFS_FINGERPRINT}`)
    return 0
  }
  const target = positional[0]
  if (!target || positional.length > 1) {
    console.error('usage : node scripts/audit-toolcalls.mjs <dossier-de-run> [--label L] [--json] [--out fichier.md] [--strict] [--motifs]')
    return 2
  }
  let result
  try {
    result = auditDir(target, { label: opts.label ?? path.basename(target) })
  } catch (e) {
    console.error(`audit impossible : ${e.message}`)
    return 2
  }
  const out = opts.json ? JSON.stringify(result, null, 2) : renderMarkdown(result)
  if (opts.out) {
    fs.writeFileSync(opts.out, out.endsWith('\n') ? out : out + '\n')
    if (!opts.json) console.error(`→ ${opts.out}`)
  } else {
    console.log(out)
  }
  const failed = result.deviations.length || result.status === 'incomplete'
  return opts.strict && failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
