// Construit le jeu de test naturel à partir de la curation (curated.json) + provenance du tirage
// (sample.jsonl, produit par natural-extract.mjs). Vérifie chaque paire contre le corpus :
// session existante, message utilisateur existant et de rôle user, question nettoyée non vide.
//
// Usage : node scripts/natural-build.mjs
import fs from 'node:fs'
import path from 'node:path'
import { corpusPaths } from '../src/paths.js'
import { readJsonl, atomicWrite, ensureDir } from '../src/util.js'

const OUT = 'eval/natural'
const curated = JSON.parse(fs.readFileSync(path.join(OUT, 'curated.json'), 'utf8'))
const sample = new Map(readJsonl(path.join(OUT, 'sample.jsonl')).map(r => [r.qid, r]))

const root = corpusPaths().root
const sessions = new Map(readJsonl(path.join(root, 'sessions.jsonl')).map(s => [s.id, s]))
const events = new Map(readJsonl(path.join(root, 'events.jsonl')).map(e => [e.id, e]))

// Artefacts injectés par le client : à retirer pour retrouver la question humaine.
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const DELEG = /^\s*Use the above message and context to generate a prompt and call the task tool.*$/gm
const clean = s => s.replace(REMINDER, ' ').replace(DELEG, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

const items = []
const problems = []
curated.forEach((c, i) => {
  const src = sample.get(c.qid)
  if (!src) { problems.push(`${c.qid} : absent du tirage (sample.jsonl)`); return }
  const ses = sessions.get(src.sessionId)
  if (!ses) { problems.push(`${c.qid} : session ${src.sessionId} introuvable dans le corpus`); return }
  const ev = events.get(src.userMsgId)
  if (!ev || ev.role !== 'user') { problems.push(`${c.qid} : message ${src.userMsgId} absent ou non-user`); return }
  const stripped = clean(src.question)
  const question = clean(c.q ?? stripped)
  if (question.length < 10) { problems.push(`${c.qid} : question vide après nettoyage`); return }
  const norm = t => t.replace(/\s+/g, ' ').replace(/\s+([?!;:,.])/g, '$1').trim()
  if (c.q && !norm(stripped).includes(norm(c.q).slice(0, Math.min(40, norm(c.q).length)))) {
    problems.push(`${c.qid} : la question réécrite ne correspond pas à l'originale`)
  }
  if (!Array.isArray(c.expect) || c.expect.length === 0) problems.push(`${c.qid} : expect vide`)
  items.push({
    id: `n${String(i + 1).padStart(2, '0')}`,
    question,
    verbatim: !c.q,
    expect: c.expect,
    ...(c.mustNot ? { mustNot: c.mustNot } : {}),
    type: c.type,
    specificity: c.specificity,
    selfContained: c.selfContained,
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
  console.error('PROBLÈMES :\n' + problems.map(p => ' - ' + p).join('\n'))
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
console.log('écrit : eval/natural/questions.jsonl, eval/natural/questions.md')
