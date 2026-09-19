// Passation : exporte les questions SEULES (aucune vérité terrain, aucune provenance de session)
// pour un agent testé dans une session neuve. Ordre mélangé de façon déterministe, pour éviter
// que les questions d'une même session se suivent.
//
// Usage :
//   node scripts/natural-list.mjs                 # liste lisible (stdout)
//   node scripts/natural-list.mjs --md            # bloc prêt à coller dans un prompt
//   node scripts/natural-list.mjs --json          # [{id, question}]
//   node scripts/natural-list.mjs --seed 42 --limit 10
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const has = f => args.includes(f)
const argOf = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def }

const FILE = argOf('--file', 'eval/natural/questions.jsonl')
const SEED = Number(argOf('--seed', 1))
const LIMIT = Number(argOf('--limit', 0))

function mulberry32 (a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

if (!fs.existsSync(FILE)) {
  console.error(`${FILE} introuvable — générer d'abord le jeu (scripts/natural-extract.mjs + curation + scripts/natural-build.mjs)`)
  process.exit(1)
}
const items = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const rnd = mulberry32(SEED)
const shuffled = items.map(it => ({ it, k: rnd() })).sort((a, b) => a.k - b.k).map(x => x.it)
const out = LIMIT > 0 ? shuffled.slice(0, LIMIT) : shuffled

if (has('--json')) {
  console.log(JSON.stringify(out.map(it => ({ id: it.id, question: it.question })), null, 2))
} else if (has('--md')) {
  console.log(out.map(it => `- **${it.id}** — ${it.question.replace(/\n+/g, ' / ')}`).join('\n'))
} else {
  for (const it of out) console.log(`[${it.id}] ${it.question.replace(/\n+/g, ' / ')}\n`)
}
