// Extraction d'un jeu de test « naturel » : tours (question utilisateur → réponse assistant)
// tirés au hasard dans le corpus, candidats pour une évaluation tenue à l'écart.
// Déterministe (graine fixe) : relancer redonne le même tirage.
//
// Source de lecture : la VUE dérivable v2 (`openView` + `inReadTx`) — UN seul snapshot
// pour toute l'extraction. Les événements sont parcourus PAR SESSION, en flux
// (`Statement.iterate()`, ordre explicite (ts, id)) : ni Map de tous les événements
// du corpus, ni double tri global. Le gain est concret, PAS une borne mémoire fixe :
// les réponses d'un tour sont accumulées INTÉGRALEMENT jusqu'au prochain message
// user (fidélité intégrale, aucun quota), donc la mémoire dépend d'un tour complet,
// des candidats et des métadonnées de session (coût assumé du tirage hors-ligne).
// Aucun repli silencieux sur `events.jsonl` (v1) : vue absente, périmée ou de
// layout non supporté = refus explicite.
//
// Usage : node scripts/natural-extract.mjs [--n 90] [--seed 20260918] [--cap 30]
//                                          [--out eval/natural] [--home RACINE]
import path from 'node:path'
import { corpusPaths } from '../src/paths.js'
import { openView, inReadTx } from '../src/view.js'
import { ensureDir, atomicWrite } from '../src/util.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const N = Number(argOf('--n', 90))
const SEED = Number(argOf('--seed', 20260918))
const OUT = argOf('--out', 'eval/natural')
const CAP = Number(argOf('--cap', 30)) // plafond par repo : diversité du tirage
const HOME = argOf('--home', null)

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

const root = HOME ? path.resolve(HOME) : corpusPaths().root

const NON_HUMAN = new Set(['explore', 'general', 'advisor'])
const BANAL = /^\s*(\/(compact|clear|help|init)\b|(continue|continuer|ok|okay|oui|non|vas-?y|go|merci|parfait|top)\s*[.!]?$)/i
const INTERRO = /\?|\b(comment|pourquoi|où|ou est|quel(le|s)?|quand|combien|est-ce que|c'?est quoi|peux-tu|peux tu|tu peux|je voudrais|j'?aimerais|explique|rappelle|retrouve|cherche|vérifie|dis-moi|fais|peut-on|on peut|il y a)\b/i
const CONCRET = /(\/[\w.-]+|\.(js|json|md|db|py|sh|toml|yaml|yml|conf)\b|\bv?\d+\.\d+(\.\d+)?\b|`[^`]+`|\b[a-z]+_[a-z_]+\b)/i

/** Tous les candidats, construits dans UN snapshot de la vue (lecture seule). */
function extractCandidates (db) {
  // Métadonnées de session : chargées une fois (coût #sessions, hors-ligne).
  const sessions = db.prepare('SELECT id, json FROM sessions').all().map(r => JSON.parse(r.json))
  const sesById = new Map(sessions.map(s => [s.id, s]))
  // Ordre de session DÉTERMINISTE (même comparateur que l'ancien tri global : `<`).
  const sessionIds = [...sesById.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  // Événements d'UNE session, en flux, ordre canonique explicite (ts, id) — les
  // lignes de titre synthétiques ne sont jamais des messages.
  const evQ = db.prepare("SELECT json FROM events WHERE session_id = ? AND role != 'title' ORDER BY ts, id")

  const cands = []
  const seen = new Set()
  for (const sid of sessionIds) {
    const ses = sesById.get(sid)
    if (!ses || ses.parentSession) continue // sous-sessions exclues du tirage

    // Un tour = la question courante + TOUTES les réponses assistant qui la suivent
    // jusqu'au prochain message user, accumulées sans quota (fidélité intégrale).
    // La mémoire dépend d'un tour complet, pas d'une Map de tous les événements.
    let pending = null // { u, answers }
    const finalize = () => {
      if (!pending) return
      const { u, answers } = pending
      pending = null
      if (!u.text) return
      const q = u.text.trim()
      if (q.length < 25 || q.length > 1200) return
      if (BANAL.test(q)) return
      if (!INTERRO.test(q)) return
      const a = answers.join('\n\n').trim()
      if (a.length < 200) return
      const key = q.slice(0, 120)
      if (seen.has(key)) return
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
    for (const row of evQ.iterate(sid)) {
      const e = JSON.parse(row.json)
      if (e.role === 'user') {
        finalize()
        if (e.agent && NON_HUMAN.has(e.agent)) { pending = null; continue }
        pending = { u: e, answers: [] }
      } else if (e.role === 'assistant') {
        if (pending && e.text) pending.answers.push(e.text.trim())
      } else {
        finalize() // rôle inattendu : le tour s'arrête (mêmes bornes que l'ancien balayage)
      }
    }
    finalize()
  }
  return cands
}

let cands
try {
  const db = openView(root) // vue absente/périmée/layout non supporté : refus explicite
  try {
    cands = inReadTx(db, () => extractCandidates(db), { root })
  } finally {
    db.close()
  }
} catch (e) {
  console.error(`natural-extract : ${e && e.message}`)
  process.exit(1)
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

// Revue humaine : version compacte (question entière, réponse tronquée) pour trier vite.
const review = sample.map((c, i) => {
  const qid = `q${String(i + 1).padStart(3, '0')}`
  c.qid = qid
  const a = c.answer.length > 900 ? c.answer.slice(0, 900) + ` […] (${c.answer.length} car.)` : c.answer
  return `## ${qid} · ${c.date} · repo=${c.repo ?? '(global)'} · ${c.model}\n**session** ${c.sessionId}\n**titre** ${c.sessionTitle}\n\n**Q** ${c.question.replace(/\n/g, ' ↵ ')}\n\n**R** ${a.replace(/\n/g, '\n> ')}\n`
}).join('\n---\n\n')

ensureDir(OUT)
atomicWrite(path.join(OUT, 'candidates.jsonl'), cands.map(c => JSON.stringify(c)).join('\n') + '\n')
atomicWrite(path.join(OUT, 'sample.jsonl'), sample.map(c => JSON.stringify(c)).join('\n') + '\n')
atomicWrite(path.join(OUT, 'sample-review.md'), review)

console.log(`candidats (après filtres) : ${cands.length}`)
console.log(`pool score>=5 : ${pool.length}`)
console.log(`échantillon   : ${sample.length} (graine ${SEED})`)
const byRepo = {}
for (const c of sample) { const k = c.repo ?? '(global)'; byRepo[k] = (byRepo[k] || 0) + 1 }
console.log('répartition  :', byRepo)
console.log(`écrit : ${OUT}/candidates.jsonl, ${OUT}/sample.jsonl, ${OUT}/sample-review.md`)
