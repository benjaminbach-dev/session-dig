// Construit le jeu de test naturel à partir de la curation (curated.json) + provenance
// du tirage (sample.jsonl, produit par natural-extract.mjs). Vérifie chaque paire
// CONTRE LA VUE v2 (`openView` + `inReadTx`, un snapshot) : session existante,
// message utilisateur EXISTANT DANS CETTE SESSION et de rôle user, question nettoyée
// non vide et correspondant au texte corpus (provenance non inventée).
//
// Aucun repli silencieux sur `events.jsonl` (v1) : vue absente, périmée ou de layout
// non supporté = refus explicite, AVANT toute écriture. Un échec ne produit jamais de
// jeu partiel : toutes les paires sont validées avant le premier `atomicWrite`.
//
// Usage : node scripts/natural-build.mjs [--out eval/natural] [--home RACINE]
import fs from 'node:fs'
import path from 'node:path'
import { corpusPaths } from '../src/paths.js'
import { openView, inReadTx } from '../src/view.js'
import { readJsonl, atomicWrite, ensureDir } from '../src/util.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const OUT = argOf('--out', 'eval/natural')
const HOME = argOf('--home', null)
const root = HOME ? path.resolve(HOME) : corpusPaths().root

const curated = JSON.parse(fs.readFileSync(path.join(OUT, 'curated.json'), 'utf8'))
const sample = new Map(readJsonl(path.join(OUT, 'sample.jsonl')).map(r => [r.qid, r]))

// Artefacts injectés par le client : à retirer pour retrouver la question humaine.
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const DELEG = /^\s*Use the above message and context to generate a prompt and call the task tool.*$/gm
const clean = s => s.replace(REMINDER, ' ').replace(DELEG, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const norm = t => t.replace(/\s+/g, ' ').replace(/\s+([?!;:,.])/g, '$1').trim()
// Étiquettes fermées (spec natural-eval) : jamais d'item avec des champs hors jeu.
const TYPES = new Set(['fait', 'etat', 'decision', 'conseil', 'veille'])
const SPECS = new Set(['high', 'medium', 'low'])

/** Valide toutes les paires contre la vue ; retourne les items ou lève. */
function buildItems (db) {
  const sesQ = db.prepare('SELECT id FROM sessions WHERE id = ?')
  // Appartenance EFFECTIVE : l'id doit exister DANS cette session ET être un message user.
  const evQ = db.prepare("SELECT json FROM events WHERE id = ? AND session_id = ? AND role = 'user'")
  const items = []
  const problems = []
  curated.forEach((c, i) => {
    const src = sample.get(c.qid)
    if (!src) { problems.push(`${c.qid} : absent du tirage (sample.jsonl)`); return }
    if (!sesQ.get(src.sessionId)) { problems.push(`${c.qid} : session ${src.sessionId} introuvable dans la vue`); return }
    const row = evQ.get(src.userMsgId, src.sessionId)
    if (!row) {
      problems.push(`${c.qid} : message ${src.userMsgId} absent de la session ${src.sessionId} (ou non-user)`)
      return
    }
    const ev = JSON.parse(row.json)
    const stripped = clean(src.question)
    const corpusQ = clean(ev.text ?? '')
    // Provenance NON INVENTÉE : la question ORIGINALE du tirage doit être
    // EXACTEMENT le texte corpus (nettoyé) — un même préfixe suivi d'une queue
    // inventée est refusé (l'inclusion de préfixe acceptait une falsification).
    if (corpusQ.length < 10 || norm(corpusQ) !== norm(stripped)) {
      problems.push(`${c.qid} : la question du tirage ne correspond pas EXACTEMENT au texte corpus de ${src.userMsgId}`)
      return
    }
    const question = clean(c.q ?? stripped)
    if (question.length < 10) { problems.push(`${c.qid} : question vide après nettoyage`); return }
    // Réécriture historique c.q : autorisée, mais son préfixe doit rester celui de l'originale.
    if (c.q && !norm(stripped).includes(norm(c.q).slice(0, Math.min(40, norm(c.q).length)))) {
      problems.push(`${c.qid} : la question réécrite ne correspond pas à l'originale`)
    }
    // Métadonnées OBLIGATOIRES (spec natural-eval) : ≥ 2 faits, étiquettes fermées,
    // booléen — une curation incomplète ne construit JAMAIS d'item aux champs undefined.
    let bad = false
    if (!Array.isArray(c.expect) || c.expect.length < 2 || c.expect.some(e => typeof e !== 'string' || !e.trim())) {
      problems.push(`${c.qid} : expect : au moins 2 faits non vides attendus`); bad = true
    }
    if (!TYPES.has(c.type)) { problems.push(`${c.qid} : type invalide (${JSON.stringify(c.type)})`); bad = true }
    if (!SPECS.has(c.specificity)) { problems.push(`${c.qid} : specificity invalide (${JSON.stringify(c.specificity)})`); bad = true }
    if (typeof c.selfContained !== 'boolean') { problems.push(`${c.qid} : selfContained doit être un booléen`); bad = true }
    if (bad) return
    items.push({
      id: `n${String(i + 1).padStart(2, '0')}`,
      question,
      verbatim: !c.q,
      expect: c.expect,
      ...(c.mustNot ? { mustNot: c.mustNot } : {}),
      type: c.type,
      specificity: c.specificity,
      selfContained: c.selfContained, // validé booléen ci-dessus
      ...(c.volatile ? { volatile: true } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
      provenance: {
        sessionId: src.sessionId,
        sessionTitle: src.sessionTitle,
        userMsgId: src.userMsgId,
        date: src.date,
        ts: src.ts,
        repo: src.repo,
        directory: src.directory,
        model: src.model,
        extractedFrom: `natural-extract.mjs (qid ${c.qid})`
      }
    })
  })
  if (problems.length) {
    const err = new Error('PROBLÈMES :\n' + problems.map(p => ' - ' + p).join('\n'))
    err.problems = problems
    throw err
  }
  return items
}

let items
try {
  const db = openView(root) // vue absente/périmée/layout non supporté : refus explicite, avant écriture
  try {
    items = inReadTx(db, () => buildItems(db), { root })
  } finally {
    db.close()
  }
} catch (e) {
  // Échec bruyant, AUCUNE écriture : un jeu partiel ne doit jamais passer inaperçu.
  console.error(e && e.problems ? e.message : `natural-build : ${e && e.message}`)
  process.exit(1)
}

ensureDir(OUT)
atomicWrite(path.join(OUT, 'questions.jsonl'), items.map(it => JSON.stringify(it)).join('\n') + '\n')
atomicWrite(path.join(OUT, 'questions.md'), items.map(it => [
  `## ${it.id} · ${it.provenance.date} · ${it.type} · ${it.specificity}${it.selfContained ? '' : ' · hors-contexte'}${it.volatile ? ' · volatile' : ''}`,
  `session: ${it.provenance.sessionId} · repo=${it.provenance.repo ?? '(global)'} · modèle=${it.provenance.model}`,
  '',
  `**Q** ${it.question}`,
  '',
  '**Vérité terrain (facts attendus)**',
  ...it.expect.map(e => `- ${e}`),
  ...(it.mustNot ? ['', '**À ne pas affirmer**', ...it.mustNot.map(e => `- ${e}`)] : []),
  ...(it.notes ? ['', `_Note : ${it.notes}_`] : []),
  ''
].join('\n')).join('\n---\n\n'))

const byType = {}, bySpec = {}, byRepo = {}
for (const it of items) {
  byType[it.type] = (byType[it.type] ?? 0) + 1
  bySpec[it.specificity] = (bySpec[it.specificity] ?? 0) + 1
  const k = it.provenance.repo ?? '(global)'
  byRepo[k] = (byRepo[k] ?? 0) + 1
}
console.log(`questions : ${items.length}`)
console.log('types        :', byType)
console.log('spécificité  :', bySpec)
console.log('repos        :', byRepo)
const dates = items.map(i => i.provenance.date).sort()
console.log(`période      : ${dates[0]} → ${dates[dates.length - 1]}`)
console.log(`sessions distinctes : ${new Set(items.map(i => i.provenance.sessionId)).size}`)
console.log(`écrit : ${OUT}/questions.jsonl, ${OUT}/questions.md`)
