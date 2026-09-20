// Audit déterministe des accès d'un run d'examen (change update-natural-eval).
//
// Rôle : filet de détection a posteriori, PAS une garantie d'exclusivité d'accès.
// Il scanne les appels d'outils enregistrés d'une exécution (un JSON par réponse,
// champ `toolCalls`) et liste les commandes qui touchent directement l'archive :
// fichiers du corpus (events.jsonl, sessions.jsonl, raw/), bases sources
// (opencode.db, index.db), invocations sqlite, `sdig ingest|refresh`, et la
// lecture des fichiers du jeu de test (qui invalide l'exécution).
//
// La liste des motifs est ÉPINGLÉE ici (MOTIFS, gelée) : toute évolution passe par
// un commit, et l'empreinte des motifs est imprimée dans le rapport pour que deux
// audits soient comparables. Les invocations légitimes de sdig (read, raw, search,
// status, index) ne sont jamais listées : un segment de commande qui est un appel
// sdig non mutant est exempté, ce qui évite les faux positifs quand une requête
// légitime cite littéralement un nom de fichier du corpus.
//
// Usage :
//   node scripts/audit-toolcalls.mjs <dossier-de-run>            # markdown sur stdout
//   node scripts/audit-toolcalls.mjs <dossier> --json            # résultat machine
//   node scripts/audit-toolcalls.mjs <dossier> --out audit.md    # écrit dans un fichier
//   node scripts/audit-toolcalls.mjs <dossier> --motifs          # imprime les motifs épinglés
//   node scripts/audit-toolcalls.mjs <dossier> --strict          # exit 1 si déviation(s)
//
// Codes de sortie : 0 = audit rendu (même avec déviations), 1 = déviation(s) et
// --strict, 2 = entrée invalide (dossier absent, aucun JSON).
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
  // Écriture du corpus : testée sur la commande entière, jamais exemptée par le
  // fait que le segment commence par sdig.
  { id: 'sdig-mutation', label: 'sdig ingest/refresh (écriture du corpus)', re: /\bsdig\b[^\n]{0,120}?(?:ingest|refresh)(?![-\w])/i, whole: true },
  // Lecture du jeu de test : n'est pas une déviation d'accès à l'archive mais
  // invalide l'exécution (spec natural-eval, « Conditions d'exécution du test »).
  { id: 'playbook', label: 'fichiers du jeu de test (exécution invalide)', re: /questions\.jsonl|questions\.md|curated\.json|\bsample-review\b|eval\/natural/i, whole: true, invalidating: true }
])

/** Empreinte stable de la liste épinglée : deux audits ne se comparent que si elle coïncide. */
export const MOTIFS_FINGERPRINT = crypto
  .createHash('sha256')
  .update(MOTIFS.map(m => `${m.id}:${m.re.source}:${m.re.flags}`).join('\n'))
  .digest('hex')
  .slice(0, 16)

const MUTATING_SUBCOMMANDS = new Set(['ingest', 'refresh'])

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
    for (const k of ['command', 'cmd', 'script', 'filePath', 'file', 'path', 'pattern', 'query', 'url', 'content']) {
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
  const m = /"(command|cmd|filePath|file|path|pattern|query)"\s*:\s*"/.exec(String(raw))
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

// --- Découpage et exemption --------------------------------------------------

/** Découpe une ligne de commande en segments (pipelines, enchaînements, sous-shells). */
export function segments (command) {
  return String(command)
    .split(/\|\||&&|[|;\n]|\$\(/)
    .map(s => s.replace(/\)\s*$/, '').trim())
    .filter(Boolean)
}

/** Tokens grossiers : coupe sur les espaces en préservant les segments entre guillemets. */
function tokenize (seg) {
  return seg.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
}

/**
 * Un segment est-il un appel sdig non mutant (read/raw/search/status/index/requête
 * libre) ? Si oui, ses motifs sont ignorés : on ne veut pas d'un faux positif
 * lorsqu'une requête légitime contient « opencode.db » ou « events.jsonl ».
 * Le test porte sur la présence de `sdig` dans le segment (et non seulement en
 * tête) pour couvrir les boucles `for q in … ; do sdig "$q" ; done`.
 */
export function isLegitSdigSegment (seg) {
  const toks = tokenize(seg)
  for (let i = 0; i < toks.length; i++) {
    const base = toks[i].replace(/^['"]|['"]$/g, '').split('/').pop()
    if (base !== 'sdig' && base !== 'sdig.js') continue
    for (let j = i + 1; j < toks.length; j++) {
      const t = toks[j].replace(/^['"]|['"]$/g, '')
      if (t.startsWith('-')) continue
      if (MUTATING_SUBCOMMANDS.has(t)) return false // sdig ingest/refresh : jamais exempté
      break
    }
    return true
  }
  return false
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
 * Motifs déclenchés par une commande. Les motifs `whole` (écriture, jeu de test)
 * sont testés sur la commande entière ; les autres segment par segment, en
 * exemptant les segments qui contiennent un appel sdig légitime. Les phrases
 * entre guillemets sont masquées (voir `maskQuotedPhrases`) : une requête qui
 * contient le mot « sqlite » n'est pas une invocation sqlite.
 */
export function matchMotifs (command) {
  const text = String(command ?? '')
  if (!text.trim()) return []
  const out = []
  const push = h => { if (h && !out.some(o => o.motif === h.motif && o.excerpt === h.excerpt)) out.push(h) }
  const wholeText = maskQuotedPhrases(text)
  for (const m of MOTIFS) if (m.whole) push(hitIn(wholeText, m))
  for (const seg of segments(text)) {
    if (isLegitSdigSegment(seg)) continue
    const masked = maskQuotedPhrases(seg)
    for (const m of MOTIFS) if (!m.whole) push(hitIn(masked, m))
  }
  return out
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
  let scanned = 0
  let recovered = 0
  for (const r of responses) {
    if (!r || typeof r !== 'object' || !r.id) continue
    scanned++
    if (r.recovered) recovered++
    const calls = Array.isArray(r.toolCalls) ? r.toolCalls : []
    calls.forEach((call, index) => {
      const { text } = extractTarget(call)
      if (!text) return
      const hits = matchMotifs(text)
      if (!hits.length) return
      deviations.push({
        id: r.id,
        callIndex: index,
        tool: call?.tool ?? '?',
        motifs: hits.map(h => h.motif),
        label: hits.map(h => h.label).join(' ; '),
        invalidating: hits.some(h => h.invalidating),
        excerpt: [...new Set(hits.map(h => h.excerpt))].slice(0, 3).join(' ⏵ '),
        command: text.replace(/\s+/g, ' ').slice(0, 300),
        question: questionShort(r.question),
        summary: answerSummary(r.answer)
      })
    })
  }
  const motifCounts = {}
  for (const d of deviations) for (const m of d.motifs) motifCounts[m] = (motifCounts[m] ?? 0) + 1
  return {
    label,
    audit: 'audit a posteriori (filet de détection, pas une garantie d\'exclusivité d\'accès)',
    motifsFingerprint: MOTIFS_FINGERPRINT,
    motifs: MOTIFS.map(m => m.id),
    scanned,
    recovered,
    deviations,
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
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return { id: f, error: true } }
  })
  const result = auditResponses(responses, { label: opts.label ?? path.basename(dir) })
  result.dir = dir
  result.files = files
  return result
}

// --- Rendu -------------------------------------------------------------------

function cell (s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() }

/** Rapport markdown : conditions de l'audit, tableau des déviations, motifs épinglés. */
export function renderMarkdown (result) {
  const L = []
  L.push(`# Audit des accès — ${result.label}`)
  L.push('')
  if (result.dir) L.push(`- Dossier : \`${result.dir}\``)
  L.push(`- Réponses scannées : **${result.scanned}**${result.recovered ? ` (dont ${result.recovered} récupérées \`recovered\`)` : ''}`)
  L.push(`- Motifs épinglés : **${result.motifs.length}** — empreinte \`${result.motifsFingerprint}\``)
  L.push(`- Nature : ${result.audit}`)
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
  L.push('')
  L.push('## Motifs épinglés')
  L.push('')
  L.push('| motif | description |')
  L.push('|---|---|')
  for (const m of MOTIFS) L.push(`| ${m.id} | ${m.label}${m.invalidating ? ' — invalide l\'exécution' : ''} |`)
  L.push('')
  return L.join('\n')
}

// --- CLI ---------------------------------------------------------------------

function main (argv) {
  const has = f => argv.includes(f)
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
  return opts.strict && result.deviations.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
