// Extraction d'un jeu de test « naturel » : tours (question utilisateur → réponse assistant)
// tirés au hasard dans le corpus, candidats pour une évaluation tenue à l'écart.
// Déterministe (graine fixe) : relancer redonne le même tirage.
//
// Usage : node scripts/natural-extract.mjs [--n 90] [--seed 20260918] [--out eval/natural]
import fs from 'node:fs'
import path from 'node:path'
import { corpusPaths } from '../src/paths.js'
import { readJsonl, ensureDir, atomicWrite } from '../src/util.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const N = Number(argOf('--n', 90))
const SEED = Number(argOf('--seed', 20260918))
const OUT = argOf('--out', 'eval/natural')
const CAP = Number(argOf('--cap', 30)) // plafond par repo : diversité du tirage

// PRNG déterministe (mulberry32) — pas de Math.random : le tirage doit être reproductible.
function mulberry32 (a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(SEED)

const root = corpusPaths().root
const sessions = readJsonl(path.join(root, 'sessions.jsonl'))
const events = readJsonl(path.join(root, 'events.jsonl'))
const sesById = new Map(sessions.map(s => [s.id, s]))

const isSub = e => !!sesById.get(e.sessionId)?.parentSession
const NON_HUMAN = new Set(['explore', 'general', 'advisor'])
const BANAL = /^\s*(\/(compact|clear|help|init)\b|(continue|continuer|ok|okay|oui|non|vas-?y|go|merci|parfait|top)\s*[.!]?$)/i
const INTERRO = /\?|\b(comment|pourquoi|où|ou est|quel(le|s)?|quand|combien|est-ce que|c'?est quoi|peux-tu|peux tu|tu peux|je voudrais|j'?aimerais|explique|rappelle|retrouve|cherche|vérifie|dis-moi|fais|peut-on|on peut|il y a)\b/i
const CONCRET = /(\/[\w.-]+|\.(js|json|md|db|py|sh|toml|yaml|yml|conf)\b|\bv?\d+\.\d+(\.\d+)?\b|`[^`]+`|\b[a-z]+_[a-z_]+\b)/i

// Regroupe les events par session, ordre chronologique.
const bySession = new Map()
const evSorted = [...events].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.ts - b.ts))
for (const e of evSorted) {
  if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, [])
  bySession.get(e.sessionId).push(e)
}

const cands = []
const seen = new Set()
for (const [sid, evs] of bySession) {
  const ses = sesById.get(sid)
  if (!ses || ses.parentSession) continue
  for (let i = 0; i < evs.length; i++) {
    const u = evs[i]
    if (u.role !== 'user' || !u.text) continue
    if (u.agent && NON_HUMAN.has(u.agent)) continue
    const q = u.text.trim()
    if (q.length < 25 || q.length > 1200) continue
    if (BANAL.test(q)) continue
    if (!INTERRO.test(q)) continue
    // Réponse = textes assistant jusqu'au prochain message utilisateur (= le tour).
    const answers = []
    for (let j = i + 1; j < evs.length && evs[j].role === 'assistant'; j++) {
      if (evs[j].text) answers.push(evs[j].text.trim())
    }
    const a = answers.join('\n\n').trim()
    if (a.length < 200) continue
    const key = q.slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    let score = 0
    if (q.trim().endsWith('?')) score += 2
    if (INTERRO.test(q)) score += 1
    if (CONCRET.test(q)) score += 1
    if (a.length >= 400 && a.length <= 5000) score += 2
    if (CONCRET.test(a)) score += 2
    if (answers.length === 1) score += 1 // une réponse nette = vérité terrain plus facile à établir
    cands.push({
      sessionId: sid,
      sessionTitle: ses.title,
      repo: ses.repo,
      directory: ses.directory,
      ts: u.ts,
      date: new Date(u.ts).toISOString().slice(0, 10),
      userMsgId: u.id,
      model: u.model ? `${u.model.providerID}/${u.model.modelID}` : null,
      qLen: q.length,
      aLen: a.length,
      score,
      question: q,
      answer: a
    })
  }
}

// Tirage aléatoire déterministe, avec plafond par repo pour garder de la diversité.
const pool = cands.filter(c => c.score >= 5)
const shuffled = pool.map(c => ({ c, k: rnd() })).sort((a, b) => a.k - b.k).map(x => x.c)
const perRepo = new Map()
const sample = []
for (const c of shuffled) {
  const k = c.repo ?? '(global)'
  const n = perRepo.get(k) ?? 0
  if (n >= CAP) continue
  perRepo.set(k, n + 1)
  sample.push(c)
  if (sample.length >= N) break
}

ensureDir(OUT)
atomicWrite(path.join(OUT, 'candidates.jsonl'), cands.map(c => JSON.stringify(c)).join('\n') + '\n')
atomicWrite(path.join(OUT, 'sample.jsonl'), sample.map(c => JSON.stringify(c)).join('\n') + '\n')

console.log(`candidats (après filtres) : ${cands.length}`)
console.log(`pool score>=5 : ${pool.length}`)
console.log(`échantillon   : ${sample.length} (graine ${SEED})`)
const byRepo = {}
for (const c of sample) { const k = c.repo ?? '(global)'; byRepo[k] = (byRepo[k] || 0) + 1 }
console.log('répartition  :', byRepo)
// Revue humaine : version compacte (question entière, réponse tronquée) pour trier vite.
const review = sample.map((c, i) => {
  const qid = `q${String(i + 1).padStart(3, '0')}`
  c.qid = qid
  const a = c.answer.length > 900 ? c.answer.slice(0, 900) + ` […] (${c.answer.length} car.)` : c.answer
  return `## ${qid} · ${c.date} · repo=${c.repo ?? '(global)'} · ${c.model}\n**session** ${c.sessionId}\n**titre** ${c.sessionTitle}\n\n**Q** ${c.question.replace(/\n/g, ' ↵ ')}\n\n**R** ${a.replace(/\n/g, '\n> ')}\n`
}).join('\n---\n\n')
atomicWrite(path.join(OUT, 'sample.jsonl'), sample.map(c => JSON.stringify(c)).join('\n') + '\n')
atomicWrite(path.join(OUT, 'sample-review.md'), review)
console.log(`écrit : ${OUT}/candidates.jsonl, ${OUT}/sample.jsonl, ${OUT}/sample-review.md`)
