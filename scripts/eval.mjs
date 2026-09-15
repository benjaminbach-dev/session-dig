// Évaluation sur recherches réelles (retour d'agent 16/09) : la pertinence se mesure
// sur des questions d'usage, pas seulement sur idempotence/contrats/perf.
// Usage : npm run eval [-- --corpus <root>]  — exit 1 si un top-1 manque.
//
// But : ~20 questions issues de l'usage réel (à alimenter dans eval/queries.json).
// Les seeds actuels sont des garde-fous de régression (titres vérifiés) ; les
// questions utilisateur sont la vraie mesure — leurs échecs documentent le manque
// lexical et arbitrent les embeddings (v2) avant tout travail dessus.
import fs from 'node:fs'
import path from 'node:path'
import { search } from '../src/retriever/bm25.js'
import { corpusPaths, corpusRoot } from '../src/paths.js'

const args = process.argv.slice(2)
let corpusArg = null
for (let i = 0; i < args.length; i++) if (args[i] === '--corpus') corpusArg = args[++i]
if (corpusArg) process.env.SESSION_DIG_HOME = corpusArg

const root = corpusRoot()
const paths = corpusPaths(root)
if (!fs.existsSync(paths.index)) {
  console.error('index absent — lancer `sdig refresh` d\'abord')
  process.exit(2)
}

const queries = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'eval', 'queries.json'), 'utf8'))
const K = 5
const rows = []
let top1 = 0, top3 = 0, top5 = 0

for (const { q, expect, note, knownMiss } of queries) {
  const hits = search(paths.index, { q, limit: K, plain: true })
  const got = hits.map(h => h.session_id)
  const r1 = expect.includes(got[0])
  const r3 = got.slice(0, 3).some(s => expect.includes(s))
  const r5 = got.slice(0, 5).some(s => expect.includes(s))
  if (r1) top1++; if (r3) top3++; if (r5) top5++
  rows.push({ q, r1, r3, r5, got: got[0] || '(vide)', expect: expect[0], knownMiss })
}

const w = Math.max(...queries.map(x => x.q.length), 8)
console.log(`éval corpus : ${root}`)
console.log(`${'question'.padEnd(w)}  top1 top3 top5   obtenu / attendu`)
let misses = 0
rows.forEach((r, i) => {
  const mark = v => v ? '✔' : (r.knownMiss ? '○' : '✘')
  if (!r.r1 && !r.knownMiss) misses++
  console.log(`${r.q.padEnd(w)}  ${mark(r.r1)}    ${mark(r.r3)}    ${mark(r.r5)}    ${r.r1 ? '—' : `${r.got} / ${r.expect}`}  ${queries[i].note ? `(${queries[i].note})` : ''}${r.knownMiss && !r.r1 ? '  [écart documenté]' : ''}`)
})
console.log(`\ntop1 ${top1}/${queries.length} · top3 ${top3}/${queries.length} · top5 ${top5}/${queries.length}`)
if (misses) {
  console.log(`\n⚠ ${misses} top-1 manquant(s) — échecs à documenter : un manque lexical répété = signal pour les embeddings (v2), pas une raison de patcher le scoring à la main.`)
  process.exit(1)
}
