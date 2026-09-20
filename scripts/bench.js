// Banc synthétique (change scale-corpus, design D5) : le parcours utilisateur complet,
// pas la seule couche FTS5. Générateur déterministe (graine épinglée) produisant une
// base source à structure opencode.db réelle (tables session/message/part, mêmes
// colonnes), puis mesure : ingestion initiale, delta, recherche rendue avec voisins,
// lecture --at avec compteurs, preuve volumineuse. Hors `npm test` (durée).
//
// Usage : node scripts/bench.js [--n EVENTS] [--sessions N] [--seed S] [--keep]
//   défaut : 100 000 événements (~20× le corpus téléphone ; le 100×/500k est à
//   exécuter sur machine cible, cf. README). Conditions consignées en sortie.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def
}
const N = argOf('--n', 100_000)
const N_SESSIONS = argOf('--sessions', Math.max(20, Math.floor(N / 500)))
const SEED = argOf('--seed', 20260920)
const KEEP = args.includes('--keep')

// PRNG déterministe (mulberry32)
function mulberry32 (a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(SEED)

const WORDS = ['proxy', 'quota', 'openspec', 'timeout', 'upstream', 'sqlite', 'embeddings', 'bug', 'latence', 'config', 'worktree', 'session', 'plugin', 'modele', 'deepseek', 'codex', 'termux', 'debian', 'corpus', 'bm25', 'fusion', 'cluster', 'token', 'cout', 'exitcode', 'adaptateur', 'schema', 'jsonl', 'raw', 'index']
const w = i => WORDS[Math.floor(rnd() * WORDS.length)]
const txt = n => Array.from({ length: n }, (_, i) => w(i)).join(' ')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-bench2-'))
const dbPath = path.join(tmp, 'opencode.db')
const root = path.join(tmp, 'corpus')
const T0 = Date.UTC(2026, 0, 1)

console.log(`banc scale-corpus : ${N} événements, ${N_SESSIONS} sessions, graine ${SEED}`)
console.log(`  machine : ${os.type()} ${os.release()} / ${os.cpus().length} cœurs, tmp ${tmp}`)

// ── 1. base source synthétique à structure opencode réelle ──
let t = performance.now()
{
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_id TEXT, slug TEXT DEFAULT 's', directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
    CREATE INDEX message_session_idx ON message(session_id, time_created, id);
    CREATE INDEX part_message_idx ON part(message_id, id);
  `)
  // sessions inégales : quelques monstres (le dernier reçoit ~10 % du corpus)
  const weights = Array.from({ length: N_SESSIONS }, () => 0.5 + rnd() * 2)
  weights[N_SESSIONS - 1] = N * 0.1 / (N / N_SESSIONS) // monstre ~10 %
  const totalW = weights.reduce((a, b) => a + b, 0)
  const insSes = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insMsg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
  const insPart = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)')
  const tx = db.transaction(() => {
    let ev = 0
    for (let s = 0; s < N_SESSIONS && ev < N; s++) {
      const sid = `ses_bench${String(s).padStart(6, '0')}`
      const size = Math.floor(N * weights[s] / totalW)
      const dir = `/root/repo${s % 20}`
      insSes.run(sid, 'p', null, 's', dir, `Session ${s} sur ${w(0)}`, null, T0 + s * 1000, T0 + s * 1000, 0, 0, 0, 0)
      for (let m = 0; m < size && ev < N; m++, ev++) {
        const mid = `msg_bench${String(ev).padStart(8, '0')}`
        const ts = T0 + ev * 1000
        const role = m % 2 ? 'assistant' : 'user'
        insMsg.run(mid, sid, ts, ts, JSON.stringify({ role, agent: 'build', providerID: 'p', modelID: `m${s % 5}` }))
        insPart.run(`prt_bench${ev}`, mid, sid, ts, ts, JSON.stringify({ type: 'text', text: `message ${ev} sur ${txt(8)}` }))
        if (m % 4 === 0) {
          insPart.run(`prt_bt${ev}`, mid, sid, ts, ts, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: `git commit -m "fix ${w(ev)}"` }, output: `ok ${ev}\n${txt(50)}\n` } }))
        }
      }
    }
  })
  tx()
  db.close()
}
console.log(`  génération source : ${(performance.now() - t).toFixed(0)} ms, ${(fs.statSync(dbPath).size / 1048576).toFixed(1)} Mo`)

// ── 2. ingestion initiale (en flux) ──
const { ingest, loadCorpus } = await import('../src/corpus.js')
const { index, search } = await import('../src/retriever/bm25.js')
const { sessionSlice } = await import('../src/read.js')
const { openView } = await import('../src/view.js')
const Database2 = Database

const rss = () => process.memoryUsage().rss / 1048576
let rssMax = 0
const track = () => { rssMax = Math.max(rssMax, rss()) }

t = performance.now()
const r1 = await ingest({ root, db: dbPath })
track()
console.log(`  ingestion initiale : ${(performance.now() - t).toFixed(0)} ms → ${r1.totals.events} events, RSS max ${rssMax.toFixed(0)} Mo`)

// ── 3. delta : un message ajouté à la session monstre (coût du layout : shard entier réécrit) ──
{
  const db = new Database(dbPath)
  const t2 = Date.now() + 100000
  const big = db.prepare("SELECT id AS session_id FROM session ORDER BY time_updated DESC LIMIT 1").get()
  const count = db.prepare('SELECT COUNT(*) n FROM message').get().n + 1
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(`msg_delta${count}`, big.session_id, t2, t2, JSON.stringify({ role: 'user', agent: 'build', providerID: 'p', modelID: 'm0' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(`prt_delta${count}`, `msg_delta${count}`, big.session_id, t2, t2, JSON.stringify({ type: 'text', text: `message delta sur ${w(1)}` }))
  db.close()
  t = performance.now()
  const r2 = await ingest({ root, db: dbPath })
  track()
  console.log(`  delta (1 msg sur session monstre) : ${(performance.now() - t).toFixed(0)} ms, ${r2.shardsTouched} shard(s) touché(s), RSS max ${rssMax.toFixed(0)} Mo`)
}

// ── 4. indexation complète (rebuild vue) ──
t = performance.now()
const rIdx = index(root)
track()
console.log(`  indexation complète : ${(performance.now() - t).toFixed(0)} ms (${rIdx.events} events), RSS max ${rssMax.toFixed(0)} Mo`)

// ── 5. recherche rendue avec voisins (--ctx), sur le parcours complet ──
{
  const { eventsBySessionDb } = await import('../src/read.js')
  const db = openView(root)
  const QUERIES = ['proxy quota', 'bug sqlite timeout', 'openspec', 'deepseek codex modele', 'session embeddings fusion']
  const times = []
  for (const q of QUERIES) {
    const t0 = performance.now()
    const hits = search(db, { q, limit: 20, plain: true })
    // voisins des hits (même snapshot)
    for (const sid of new Set(hits.map(h => h.session_id))) {
      const idxs = hits.filter(h => h.session_id === sid).map(h => db.prepare("SELECT COUNT(*) n FROM events WHERE session_id = ? AND role != 'title' AND (ts < ? OR (ts = ? AND id < ?))").get(sid, h.ts, h.ts, h.id).n)
      eventsBySessionDb(db, sid, idxs, 3)
    }
    track()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p95 = times[Math.floor(times.length * 0.95)] ?? times[times.length - 1]
  console.log(`  recherche rendue (+voisins) : p50 ${times[Math.floor(times.length / 2)].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (cible < 100 ms @ 500k)`)
  db.close()
}

// ── 6. lecture --at avec compteurs sur la session monstre ──
{
  const db = openView(root)
  const big = db.prepare("SELECT session_id, COUNT(*) n FROM events WHERE role != 'title' GROUP BY session_id ORDER BY n DESC LIMIT 1").get()
  const mid = db.prepare("SELECT id, ts FROM events WHERE session_id = ? AND role != 'title' ORDER BY ts LIMIT 1 OFFSET ?").get(big.session_id, Math.floor(big.n / 2))
  const t0 = performance.now()
  const slice = sessionSlice(root, big.session_id, { at: String(mid.ts) })
  track()
  console.log(`  read --at (session ${big.n} msgs, compteur de plage) : ${(performance.now() - t0).toFixed(0)} ms, masqués ${slice.maskedCount} (cible < 100 ms @ 10k)`)
  db.close()
}

// ── 7. preuve volumineuse ──
{
  const bigRaw = path.join(root, 'raw')
  // trouver un raw et l'agrandir artificiellement pour le scan par blocs
  const { rawShardPath } = await import('../src/layout.js')
  const f = path.join(bigRaw, '00')
  const first = fs.readdirSync(bigRaw + '/00')[0]
  const file = rawShardPath(bigRaw, first.slice(0, -4))
  const size = fs.statSync(file).size
  t = performance.now()
  const { streamBlocks } = await import('../src/util.js')
  let bytes = 0
  streamBlocks(file, { onBlock: (b) => { bytes += b.length } })
  console.log(`  preuve (${(size / 1024).toFixed(0)} Ko) lue par blocs : ${(performance.now() - t).toFixed(1)} ms`)
}

console.log(`  RSS maximale du banc : ${rssMax.toFixed(0)} Mo (cible < 512 Mo)`)
void loadCorpus; void Database2
if (KEEP) console.log(`  (conservé pour inspection : ${tmp}`)
else fs.rmSync(tmp, { recursive: true, force: true })
console.log('  conditions : cache froid (tmpfs), corpus généré puis lu une fois ; mesures répétées sur machine cible pour p95.')
