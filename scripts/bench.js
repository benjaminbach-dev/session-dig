// Bench v0 (spec search : performance vérifiée à l'implémentation et consignée).
// Génère ~5000 events synthétiques → indexation + requêtes. Usage : npm run bench
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { atomicWrite, ensureDir } from '../src/util.js'
import { index, search } from '../src/retriever/bm25.js'

const N = Number(process.env.BENCH_N || 5000)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-bench-'))
const root = path.join(tmp, 'corpus')
const indexPath = path.join(root, 'index.db')
ensureDir(root)

const WORDS = ['proxy', 'quota', 'openspec', 'timeout', 'upstream', 'sqlite', 'embeddings', 'bug', 'latence', 'config', 'worktree', 'session', 'plugin', 'modele', 'deepseek', 'codex', 'termux', 'debian', 'corpus', 'bm25', 'fusion', 'cluster', 'token', 'cout', 'exitcode', 'adaptateur', 'schema', 'jsonl', 'raw', 'index']
const rnd = (i) => WORDS[(i * 7919) % WORDS.length]
const events = []
for (let i = 0; i < N; i++) {
  const s = `s_${i % 200}`
  events.push({
    schemaVersion: 1,
    id: `ev_${i}`, sessionId: s, ts: Date.UTC(2026, 0, 1) + i * 60000,
    role: i % 3 === 0 ? 'user' : 'assistant',
    text: `message ${i} sur ${rnd(i)} et ${rnd(i + 1)} avec contexte ${rnd(i + 2)}`,
    model: { providerID: 'p', modelID: `m${i % 5}` }, agent: 'build',
    repo: `repo${i % 20}`, tokens: {}, cost: 0,
    ...(i % 4 === 0 ? { toolCalls: [{ tool: 'bash', cmd: `git commit -m "fix ${rnd(i)}"` }] } : {})
  })
}

console.log(`bench : ${N} events synthétiques, ${new Set(events.map(e => e.sessionId)).size} sessions`)
let t = performance.now()
atomicWrite(path.join(root, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
atomicWrite(path.join(root, 'sessions.jsonl'), '')
console.log(`  écriture corpus : ${(performance.now() - t).toFixed(0)} ms`)

t = performance.now()
index(root, indexPath)
console.log(`  indexation bm25 : ${(performance.now() - t).toFixed(0)} ms`)

const QUERIES = ['proxy quota', 'bug sqlite timeout', 'openspec', 'deepseek codex modele', 'session embeddings fusion']
let worst = 0
for (const q of QUERIES) {
  t = performance.now()
  const hits = search(indexPath, { q, limit: 20, plain: true })
  const ms = performance.now() - t
  worst = Math.max(worst, ms)
  console.log(`  requête "${q}" : ${ms.toFixed(1)} ms → ${hits.length} hit(s)`)
}
console.log(`  pire requête : ${worst.toFixed(1)} ms (cible spec : < 100 ms)`)
fs.rmSync(tmp, { recursive: true, force: true })
