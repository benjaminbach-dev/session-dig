// Banc synthétique fidèle (change scale-corpus, design D5 ; passe corrective 06/10/2026).
//
// Objectif : mesurer le PARCOURS UTILISATEUR COMPLET sur une source synthétique à
// structure opencode.db réelle, pas la seule couche FTS5. Le banc REND réellement
// (recherche groupée + voisins dans une transaction de lecture ; lecture --at par
// flux au sink comptage/hash), génère une VRAIE preuve géante dans la source
// (jamais en éditant raw/ hors ingestion), et mesure le pic RSS OS cumulatif de
// la vie du process (`process.resourceUsage().maxRSS`, jamais un échantillon isolé).
//
// Usage : node scripts/bench.js [--n EVENTS] [--sessions N] [--seed S] [--runs R]
//                               [--raw-mib MIB] [--keep] [--help]
//   --n         événements exacts (défaut 100000)
//   --sessions  sessions exactes (défaut max(20, N/500))
//   --seed      graine du PRNG (défaut 20260920)
//   --runs      répétitions TIMÉES après échauffement (défaut 20, min 3)
//   --raw-mib   taille de la preuve géante écrite dans la source (défaut 16 Mio)
//   --keep      conserve le répertoire temporaire (inspection)
//
// Le banc est HORS `npm test` (durée). Un smoke durable l'exerce à petite échelle
// (`test/bench-smoke.test.js`). Aucune cible de perf n'est un gate : les cibles
// sont affichées à titre indicatif, sans arbitrage automatique.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { constants as bufferConstants } from 'node:buffer'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

// ── Arguments STRICTS, validés AVANT toute création de fichier ───────────────
// Bornes TECHNIQUES, pas des quotas de performance : `--seed` tient sur 32 bits
// (mulberry32 fait `a |= 0`) ; `--raw-mib` est borné par MAX_STRING_LENGTH
// (la preuve géante est une chaîne répétée) ; `--n` par Number.MAX_SAFE_INTEGER.
function parseArgs (argv) {
  const flags = { keep: false, help: false }
  const NUM_OPTS = new Set(['--n', '--sessions', '--seed', '--runs', '--raw-mib'])
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') { flags.keep = true; continue }
    if (a === '--help' || a === '-h') { flags.help = true; continue }
    if (NUM_OPTS.has(a)) {
      if (seen.has(a)) fail(`${a} : option répétée (une seule valeur admise)`)
      seen.add(a)
      i++ // valeur consommée ici ; validée par num() ci-dessous
      continue
    }
    if (a.startsWith('-')) fail(`option inconnue : ${a}`)
    fail(`argument positionnel refusé : ${a}`)
  }
  const num = (name, def, min, max) => {
    const i = argv.indexOf(name)
    if (i < 0) return def
    const raw = argv[i + 1]
    if (raw == null || !/^\d+$/.test(raw)) fail(`${name} : entier positif attendu`)
    const v = Number(raw)
    if (!Number.isSafeInteger(v) || v < min) fail(`${name} : valeur hors bornes (≥ ${min})`)
    if (max != null && v > max) fail(`${name} : valeur hors bornes (≤ ${max})`)
    return v
  }
  const MAX_RAW_MIB = Math.floor(bufferConstants.MAX_STRING_LENGTH / 1048576)
  const n = num('--n', 100_000, 10)
  const sessions = num('--sessions', Math.max(20, Math.floor(n / 500)), 2)
  const seed = num('--seed', 20260920, 0, 0xffffffff)
  const runs = num('--runs', 20, 3)
  const rawMib = num('--raw-mib', 16, 1, MAX_RAW_MIB)
  const monster = Math.floor(n * 0.10)
  if (monster < 1) fail('--n : trop petit pour un monstre de 10 % (≥ 10)')
  if (n - monster < sessions - 1) fail(`--sessions : trop de sessions pour ${n} événements (chaque session ≥ 1)`)
  return { n, sessions, seed, runs, rawMib, monster, keep: flags.keep, help: flags.help }
}

function fail (msg) {
  console.error(`banc: ${msg}`)
  process.exit(2)
}

const USAGE = `banc synthétique session-dig — parcours complet sur source opencode-like

Usage: node scripts/bench.js [--n EVENTS] [--sessions N] [--seed S] [--runs R]
                             [--raw-mib MIB] [--keep] [--help]

  --n         événements exacts (défaut 100000, min 10)
  --sessions  sessions exactes (défaut max(20, N/500), min 2)
  --seed      graine PRNG (défaut 20260920)
  --runs      répétitions timées après échauffement (défaut 20, min 3)
  --raw-mib   preuve géante écrite dans la SOURCE puis ingérée (défaut 16 Mio)
  --keep      conserve le répertoire temporaire`

// ── PRNG déterministe (mulberry32) ───────────────────────────────────────────
function mulberry32 (a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['proxy', 'quota', 'openspec', 'timeout', 'upstream', 'sqlite', 'embeddings', 'bug', 'latence', 'config', 'worktree', 'session', 'plugin', 'modele', 'deepseek', 'codex', 'termux', 'debian', 'corpus', 'bm25', 'fusion', 'cluster', 'token', 'cout', 'exitcode', 'adaptateur', 'schema', 'jsonl', 'raw', 'index']

// ── Outils de mesure ─────────────────────────────────────────────────────────
const NOW = () => performance.now()
const peakRssMib = () => process.resourceUsage().maxRSS / 1024
const fmtMs = (ms) => `${ms.toFixed(ms < 10 ? 2 : 0)} ms`
const fmtMib = (n) => `${n.toFixed(1)} Mio`

/** Taille disque RÉCURSIVE (fichiers réguliers), sans suivre les liens. */
function dirSize (dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; files++ } catch {} }
    }
  }
  walk(dir)
  return { bytes, files }
}

/** Quantile NEAREST-RANK : rang = ceil(p·n), 1-indexé. Méthode affichée avec n. */
function quantile (sortedAsc, p) {
  if (!sortedAsc.length) return NaN
  const rank = Math.ceil(p * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]
}

function stats (samples) {
  const s = [...samples].sort((a, b) => a - b)
  return { n: s.length, min: s[0], max: s[s.length - 1], p50: quantile(s, 0.50), p95: quantile(s, 0.95) }
}

/** Échauffement (non timé) puis `runs` itérations timées. Supporte async. */
async function benchOp (label, fn, { warmup = 3, runs }) {
  for (let i = 0; i < warmup; i++) await fn()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const t0 = NOW()
    await fn()
    samples.push(NOW() - t0)
  }
  const st = stats(samples)
  console.log(`  ${label} : p50 ${fmtMs(st.p50)}, p95 ${fmtMs(st.p95)} (nearest-rank, n=${st.n}, min ${fmtMs(st.min)}, max ${fmtMs(st.max)})`)
  return st
}

const check = (cond, msg) => { if (!cond) throw new Error(`assertion échouée : ${msg}`) }

// ── Générateurs synthétiques ─────────────────────────────────────────────────
const iso = (ms) => new Date(ms).toISOString()

/** Partition EXACTE : monstre = floor(N·0.10), le reste réparti inégalement (≥ 1). */
function partition (n, sessions, monster, rnd) {
  const rest = n - monster
  const others = sessions - 1
  check(rest >= others, 'partition : au moins 1 événement par session non-monstre')
  const weights = Array.from({ length: others }, () => 0.5 + rnd() * 2)
  const totalW = weights.reduce((a, b) => a + b, 0)
  const remaining = rest - others // base 1 garantie à chaque session non-monstre
  const sizes = weights.map(x => 1 + Math.floor(remaining * x / totalW))
  const drift = rest - sizes.reduce((a, b) => a + b, 0)
  sizes[others - 1] += drift
  check(sizes.every(s => s >= 1), 'partition : chaque session non-monstre reçoit ≥ 1 événement')
  return [...sizes, monster] // monstre en DERNIER
}

function makeOpencodeSource ({ dbPath, n, sessions, seed, rawMib, giantPartId }) {
  const rnd = mulberry32(seed)
  const sizes = partition(n, sessions, Math.floor(n * 0.10), rnd)
  check(sizes.reduce((a, b) => a + b, 0) === n, 'génération : somme des sessions = N')
  const giant = rawMib * 1024 * 1024
  const giantOutput = 'G'.repeat(giant) // ASCII : taille octets = longueur
  const T0 = Date.UTC(2026, 0, 1)
  const db = new Database(dbPath)
  let ev = 0
  try {
    db.exec(`
      CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_id TEXT, slug TEXT DEFAULT 's', directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
      CREATE INDEX message_session_idx ON message(session_id, time_created, id);
      CREATE INDEX part_message_idx ON part(message_id, id);
    `)
    const insSes = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const insMsg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
    const insPart = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)')
    const txt = (k) => Array.from({ length: 8 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ')
    const tx = db.transaction(() => {
      for (let s = 0; s < sessions; s++) {
        const sid = `ses_bench${String(s).padStart(6, '0')}`
        insSes.run(sid, 'p', null, 's', `/root/repo${s % 20}`, `Session ${s}`, null, T0 + s * 1000, T0 + s * 1000, 0, 0, 0, 0)
        for (let m = 0; m < sizes[s]; m++, ev++) {
          const mid = `msg_bench${String(ev).padStart(8, '0')}`
          const ts = T0 + ev * 1000
          insMsg.run(mid, sid, ts, ts, JSON.stringify({ role: m % 2 ? 'assistant' : 'user', agent: 'build', providerID: 'p', modelID: `m${s % 5}` }))
          insPart.run(`prt_bench${ev}`, mid, sid, ts, ts, JSON.stringify({ type: 'text', text: `message ${ev} sur ${txt()}` }))
          if (m % 4 === 0) {
            insPart.run(`prt_bt${ev}`, mid, sid, ts, ts, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: `git commit -m "fix ${txt()}"` }, output: `ok ${ev}\n` } }))
          }
          // PREUVE GÉANTE : insérée dans la SOURCE (tool part), jamais en éditant raw/.
          if (ev === 0) {
            insPart.run(giantPartId, mid, sid, ts + 1, ts + 1, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'cat giant.log' }, output: giantOutput } }))
          }
        }
      }
    })
    tx()
  } finally {
    db.close() // fermée sur TOUTES les erreurs de schéma/transaction
  }
  check(ev === n, `génération : ${ev} événements générés ≠ ${n}`)
  return {
    sizes,
    monsterSid: `ses_bench${String(sessions - 1).padStart(6, '0')}`,
    monsterCount: sizes[sessions - 1],
    giantOutput,
    giantBytes: Buffer.byteLength(giantOutput, 'utf8'),
    giantMd5: crypto.createHash('md5').update(giantOutput, 'utf8').digest('hex')
  }
}

/** Session pi JSONL synthétique (append-only), sans données réelles. */
function piLines (uuid, cwd, count, startMs, idPrefix) {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: uuid, timestamp: iso(startMs), cwd }),
    JSON.stringify({ type: 'session_info', id: `${idPrefix}i`, parentId: null, timestamp: iso(startMs + 1), name: `Pi ${uuid.slice(0, 6)}` })
  ]
  for (let i = 0; i < count; i++) {
    const ts = startMs + 1000 + i * 10
    const role = i % 2 ? 'assistant' : 'user'
    const message = { role, content: [{ type: 'text', text: `message pi ${i} sur ${WORDS[i % WORDS.length]}` }], timestamp: ts }
    if (role === 'assistant') { message.provider = 'antho'; message.model = 'sonnet-x' }
    lines.push(JSON.stringify({ type: 'message', id: `${idPrefix}m${String(i).padStart(6, '0')}`, parentId: null, timestamp: iso(ts), message }))
  }
  return lines
}

function writePiFixture (piDir, { files, bigFileMessages, seed }) {
  fs.mkdirSync(piDir, { recursive: true })
  const T0 = Date.UTC(2027, 0, 15)
  let bytes = 0
  let messages = 0
  for (let f = 0; f < files; f++) {
    const uuid = `bbbbbbbb-0000-7000-8000-${String(f).padStart(12, '0')}`
    const count = f === files - 1 ? bigFileMessages : 2 // un GROS fichier + petits fichiers découverte
    const lines = piLines(uuid, `/synthetic/pi-${f}`, count, T0 + f * 1_000_000, `c${String(f).padStart(4, '0')}`)
    const body = lines.join('\n') + '\n'
    const rel = `proj-${String(f).padStart(3, '0')}/session-${f}.jsonl`
    const abs = path.join(piDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
    bytes += Buffer.byteLength(body, 'utf8')
    messages += count
  }
  return { bytes, messages, bigRel: `proj-${String(files - 1).padStart(3, '0')}/session-${files - 1}.jsonl`, seed }
}

// ── Phases ───────────────────────────────────────────────────────────────────

/**
 * EXPLAIN QUERY PLAN des TROIS requêtes EXACTES de `src/adapter/opencode-page.js`
 * (`adaptPaged`), reproduites ici volontairement (aucun refactor production dans ce
 * lot) : sessions fallback (sans index time_updated), sessions keyset (avec index),
 * messages du delta. Paramètres REPRÉSENTATIFS : watermark récent (max − 1000), pas
 * `-1`. Plans observés sans puis avec un index de TÊTE `time_updated` (créé puis
 * retiré : structure source rendue inchangée).
 */
function explainPlans (dbPath) {
  const db = new Database(dbPath, { readonly: false })
  try {
    const batchSize = 2000
    const since = db.prepare('SELECT COALESCE(MAX(time_updated), 0) m FROM message').get().m - 1000
    const sinceSession = db.prepare('SELECT COALESCE(MAX(time_updated), 0) m FROM session').get().m - 1000
    const queries = {
      'sessions fallback (sans index time_updated)': {
        sql: 'SELECT * FROM session WHERE time_updated > ? AND id > ? ORDER BY id LIMIT ?',
        params: [sinceSession, '', batchSize]
      },
      'sessions keyset (avec index time_updated)': {
        sql: 'SELECT * FROM session WHERE time_updated > ? AND (time_updated > ? OR (time_updated = ? AND id > ?)) ORDER BY time_updated, id LIMIT ?',
        params: [sinceSession, -1, -1, '', batchSize]
      },
      'messages du delta (groupés par session)': {
        sql: 'SELECT * FROM message WHERE time_updated > ? ORDER BY session_id, time_created, id',
        params: [since]
      }
    }
    const run = () => {
      const out = {}
      for (const [label, { sql, params }] of Object.entries(queries)) {
        out[label] = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail)
      }
      return out
    }
    const without = run()
    db.exec('CREATE INDEX message_updated_idx ON message(time_updated)')
    db.exec('CREATE INDEX session_updated_idx ON session(time_updated)')
    const withIdx = run()
    db.exec('DROP INDEX message_updated_idx')
    db.exec('DROP INDEX session_updated_idx')
    console.log('  EXPLAIN QUERY PLAN — requêtes EXACTES de l’adaptateur (opencode-page.js), params watermark récent :')
    for (const label of Object.keys(queries)) {
      console.log(`    ${label}`)
      console.log(`      sans index de tête time_updated : ${without[label].join(' | ')}`)
      console.log(`      avec index de tête time_updated : ${withIdx[label].join(' | ')}`)
    }
    console.log('    (un index time_updated n’implique PAS un coût O(delta) : l’ORDER BY session_id,time_created,id des messages peut forcer un tri que cet index ne fournit pas)')
  } finally { db.close() }
}

async function main (opts) {
  const { n, sessions, seed, runs, rawMib, monster } = opts
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-bench-'))
  const dbPath = path.join(tmp, 'opencode.db')
  const root = path.join(tmp, 'corpus')
  const piDir = path.join(tmp, 'pi')
  const rootPi = path.join(tmp, 'corpus-pi')
  const giantPartId = 'prt_giant_bench'

  // Hermétique : la source pi par défaut ne doit JAMAIS être touchée par le banc.
  process.env.SESSION_DIG_PI_DIR = piDir

  console.log('banc scale-corpus (méthode corrigée 06/10/2026)')
  console.log(`  paramètres : n=${n}, sessions=${sessions}, seed=${seed}, runs=${runs}, raw=${rawMib} Mio`)
  console.log(`  machine : ${os.type()} ${os.release()} ${os.arch()} / ${os.cpus().length} cœurs / Node ${process.version}`)
  console.log(`  mémoire : ${fmtMib(os.freemem() / 1048576)} libres sur ${fmtMib(os.totalmem() / 1048576)}`)
  console.log(`  tmp : ${tmp} (FS non contrôlé : ni drop_caches ni tmpfs revendiqué)`)
  console.log('  cache : NON contrôlé (mesures répétées après échauffement, méthode affichée)')

  let gen = null
  let r1 = null
  let rDelta = null
  let rEmpty = null
  let rIdx = null

  try {
    // 1. Génération de la source synthétique (exactement N événements).
    let t0 = NOW()
    gen = makeOpencodeSource({ dbPath, n, sessions, seed, rawMib, giantPartId })
    const genMs = NOW() - t0
    check(gen.monsterCount === monster, `monstre ${gen.monsterCount} ≠ 10 % attendu ${monster}`)
    console.log(`  génération source : ${fmtMs(genMs)}, ${fmtMib(fs.statSync(dbPath).size / 1048576)} (${n} événements, monstre ${gen.monsterCount})`)

    explainPlans(dbPath)

    const { ingest } = await import('../src/corpus.js')
    const { index, search } = await import('../src/retriever/bm25.js')
    const { streamRead, neighborsBySessionDb } = await import('../src/read.js')
    const { openView, inReadTx } = await import('../src/view.js')
    const { renderTerminal, readTerminalChunks } = await import('../src/format.js')
    const { rawShardPath } = await import('../src/layout.js')
    const { md5File, streamBytes } = await import('../src/util.js')

    const loadSessionsById = (db, ids) => {
      if (!ids.length) return new Map()
      const rows = db.prepare(`SELECT id, json FROM sessions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      return new Map(rows.map(r => [r.id, JSON.parse(r.json)]))
    }

    // 2. Ingestion initiale (en flux) — exactement N événements / `sessions` sessions.
    t0 = NOW()
    r1 = await ingest({ root, db: dbPath, source: 'opencode' })
    console.log(`  ingestion initiale : ${fmtMs(NOW() - t0)} → ${r1.totals.events} events, ${r1.totals.sessions} sessions, ${r1.rawWritten} raw écrit(s)`)
    check(r1.totals.events === n, `ingestion : ${r1.totals.events} events ≠ ${n}`)
    check(r1.totals.sessions === sessions, `ingestion : ${r1.totals.sessions} sessions ≠ ${sessions}`)
    check(r1.rawWritten >= 1, 'ingestion : la preuve géante doit écrire au moins un raw')

    // 3. Delta (+1) sur la session monstre, puis passe VIDE stable.
    {
      const db = new Database(dbPath)
      try {
        const t = Date.now() + 1_000_000_000
        db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_delta1', gen.monsterSid, t, t, JSON.stringify({ role: 'user', agent: 'build', providerID: 'p', modelID: 'm0' }))
        db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_delta1', 'msg_delta1', gen.monsterSid, t, t, JSON.stringify({ type: 'text', text: 'delta' }))
      } finally { db.close() }
    }
    t0 = NOW()
    rDelta = await ingest({ root, db: dbPath, source: 'opencode' })
    console.log(`  delta (+1) : ${fmtMs(NOW() - t0)}, added ${rDelta.added}, ${rDelta.shardsTouched} shard(s), raw ${rDelta.rawWritten}`)
    check(rDelta.added === 1, `delta : added ${rDelta.added} ≠ 1`)

    t0 = NOW()
    rEmpty = await ingest({ root, db: dbPath, source: 'opencode' })
    console.log(`  passe vide : ${fmtMs(NOW() - t0)}, added ${rEmpty.added}, shards ${rEmpty.shardsTouched}`)
    check(rEmpty.added === 0 && rEmpty.shardsTouched === 0, 'passe vide : rien ne doit être réécrit')

    // 4. Rebuild complet de la vue.
    t0 = NOW()
    rIdx = index(root)
    console.log(`  rebuild vue : ${fmtMs(NOW() - t0)} (${rIdx.events} events)`)
    check(rIdx.events === n + 1, `rebuild : ${rIdx.events} events ≠ ${n + 1}`)

    // 5. Recherche RENDUE (+ voisins) dans UNE transaction de lecture.
    const QUERIES = ['proxy quota', 'bug sqlite timeout', 'openspec', 'deepseek codex modele', 'session embeddings fusion']
    let qi = 0
    const searchOp = () => {
      const q = QUERIES[qi++ % QUERIES.length]
      const db = openView(root)
      try {
        return inReadTx(db, () => {
          const hits = search(db, { q, limit: 20, plain: true })
          const ids = [...new Set(hits.map(h => h.session_id))]
          const sessionsById = loadSessionsById(db, ids)
          const ctxBySession = new Map()
          for (const sid of ids) {
            const win = neighborsBySessionDb(db, sid, hits.filter(h => h.session_id === sid), 3).get(sid)
            if (win) ctxBySession.set(sid, win)
          }
          const rendered = renderTerminal(hits, sessionsById, { ctx: 3, ctxBySession, plain: true })
          return { hits, rendered }
        }, { root })
      } finally { db.close() }
    }
    const warmSearch = searchOp()
    check(warmSearch.hits.length > 0, 'recherche : au moins un hit')
    check(warmSearch.rendered.length > 0, 'recherche : rendu non vide')
    await benchOp('recherche rendue (+voisins, tx)', searchOp, { runs })
    console.log(`    (p95 sur ${runs} itérations cyclant ${QUERIES.length} requêtes hétérogènes — agrégat, pas une requête unique)`)
    console.log(`    (exemple : ${warmSearch.hits.length} hits, ${Buffer.byteLength(warmSearch.rendered, 'utf8')} octets UTF-8 rendus — contenu jamais affiché)`)

    // 6. Lecture --at EN FLUX (streamRead) rendue au sink comptage/hash.
    let anchorTs = null
    let monsterTotal = null
    {
      const db = openView(root)
      try {
        monsterTotal = db.prepare("SELECT COUNT(*) n FROM events WHERE session_id = ? AND role != 'title'").get(gen.monsterSid).n
        const mid = db.prepare("SELECT ts FROM events WHERE session_id = ? AND role != 'title' ORDER BY ts, id LIMIT 1 OFFSET ?").get(gen.monsterSid, Math.floor(monsterTotal / 2))
        anchorTs = String(mid.ts)
      } finally { db.close() }
    }
    check(monsterTotal === monster + 1, `lecture : total monstre ${monsterTotal} ≠ ${monster + 1} (delta inclus)`)
    const renderRead = async () => {
      const h = crypto.createHash('md5')
      let bytes = 0
      let w = null
      const it = streamRead(root, gen.monsterSid, { at: anchorTs })[Symbol.asyncIterator]()
      try {
        const head = await it.next()
        w = head.value.window
        const slice = { ...w, error: w.warning ?? null }
        const events = { [Symbol.asyncIterator]: () => it }
        for await (const chunk of readTerminalChunks(slice, gen.monsterSid, { plain: true }, events)) {
          bytes += Buffer.byteLength(chunk, 'utf8')
          h.update(chunk)
        }
      } finally {
        // Erreur avant/pendant le rendu : refermer le flux (transaction comprise).
        try { await it.return?.() } catch {}
      }
      return { bytes, hash: h.digest('hex'), window: w }
    }
    const readA = await renderRead()
    const readB = await renderRead()
    check(readA.window.total === monsterTotal, `read --at : total ${readA.window.total} ≠ ${monsterTotal}`)
    check(readA.window.visible + readA.window.maskedCount === readA.window.total, 'read --at : visible + masqués = total')
    check(readA.window.anchor && readA.window.anchor.ts != null, 'read --at : ancre résolue')
    check(readA.bytes > 0, 'read --at : rendu non vide')
    check(readA.hash === readB.hash, 'read --at : rendu déterministe (hash identique)')
    await benchOp('read --at (streamRead → sink hash)', renderRead, { runs })
    console.log(`    (session ${monsterTotal} msgs, visibles ${readA.window.visible}, masqués ${readA.window.maskedCount}, hash ${readA.hash.slice(0, 12)}…)`)

    // 7. Preuve géante : bytes/hash EXACTS, écrite par l'ingestion (jamais à la main).
    {
      const rawFile = rawShardPath(path.join(root, 'raw'), giantPartId)
      check(fs.existsSync(rawFile), 'preuve géante : raw écrit par l’ingestion introuvable')
      const stat = fs.statSync(rawFile)
      check(stat.size === gen.giantBytes, `preuve : taille ${stat.size} ≠ ${gen.giantBytes}`)
      check(md5File(rawFile) === gen.giantMd5, 'preuve : md5 fichier ≠ md5 attendu')
      let counted = 0
      const h = crypto.createHash('md5')
      const t = NOW()
      streamBytes(rawFile, (b) => { counted += b.length; h.update(b) })
      const ms = NOW() - t
      check(counted === gen.giantBytes, `preuve : streamBytes ${counted} ≠ ${gen.giantBytes}`)
      check(h.digest('hex') === gen.giantMd5, 'preuve : md5 streamBytes ≠ attendu')
      console.log(`  preuve géante : ${fmtMib(gen.giantBytes / 1048576)} lue par blocs en ${fmtMs(ms)} (bytes/hash EXACTS)`)
    }

    // 8. Coût d'un fichier pi CHANGÉ (relecture intégrale) vs petits fichiers découverte.
    {
      const piFiles = Math.min(sessions, 8)
      const bigMessages = Math.max(500, Math.min(50_000, Math.floor(n / 5)))
      const fixture = writePiFixture(piDir, { files: piFiles, bigFileMessages: bigMessages, seed })
      t0 = NOW()
      const pi1 = await ingest({ root: rootPi, piDir, source: 'pi' })
      const piInitMs = NOW() - t0
      check(pi1.added === fixture.messages, `pi initial : added ${pi1.added} ≠ ${fixture.messages}`)
      check(pi1.pi && pi1.pi.files === piFiles, `pi initial : fichiers suivis ${pi1.pi && pi1.pi.files} ≠ ${piFiles}`)
      const stateBytes = Buffer.byteLength(JSON.stringify(pi1.sources.pi.files), 'utf8')
      const trackedBytes = Object.values(pi1.sources.pi.files).reduce((a, f) => a + (f.size || 0), 0)
      console.log(`  pi initial : ${fmtMs(piInitMs)}, ${pi1.added} events, ${pi1.pi.files} fichiers suivis, ${fmtMib(trackedBytes / 1048576)} suivis, état ${stateBytes} o`)

      // Append d'UN message au GROS fichier : seule la relecture de ce fichier est attendue.
      const bigAbs = path.join(piDir, fixture.bigRel)
      const extraTs = Date.UTC(2027, 5, 1) + 1234
      fs.appendFileSync(bigAbs, JSON.stringify({ type: 'message', id: 'bigapp1', parentId: null, timestamp: iso(extraTs), message: { role: 'user', content: [{ type: 'text', text: 'append bench' }], timestamp: extraTs } }) + '\n')
      t0 = NOW()
      const pi2 = await ingest({ root: rootPi, piDir, source: 'pi' })
      const piAppendMs = NOW() - t0
      check(pi2.added === 1, `pi append : added ${pi2.added} ≠ 1`)
      console.log(`  pi append (1 msg dans le gros fichier) : ${fmtMs(piAppendMs)}, added ${pi2.added}, ${pi2.pi.files} fichiers suivis`)

      // Aucun delta : coût O(stat) de découverte, aucun événement.
      t0 = NOW()
      const pi3 = await ingest({ root: rootPi, piDir, source: 'pi' })
      const piNoDeltaMs = NOW() - t0
      check(pi3.added === 0 && pi3.updated === 0, 'pi sans delta : rien ne doit être relu/ajouté')
      console.log(`  pi sans delta : ${fmtMs(piNoDeltaMs)}, added ${pi3.added}`)
      console.log(`    (petits fichiers découverte : ${piFiles - 1} ; gros fichier : ${fmtMib(fs.statSync(bigAbs).size / 1048576)} — relecture INTÉGRALE au changement, non isolée des autres coûts de passe)`)
    }

    // 9. Disque et pic RSS OS cumulatif.
    const corpusDisk = dirSize(root)
    const piDisk = dirSize(rootPi)
    const tmpDisk = dirSize(tmp)
    console.log(`  disque : corpus ${fmtMib(corpusDisk.bytes / 1048576)} (${corpusDisk.files} fichiers), pi ${fmtMib(piDisk.bytes / 1048576)} (${piDisk.files}), tmp total ${fmtMib(tmpDisk.bytes / 1048576)}`)
    console.log(`  pic RSS OS cumulatif (process.resourceUsage().maxRSS) : ${fmtMib(peakRssMib())} — cible indicative < 512 Mio, NON un gate`)

    console.log(`banc : OK (n=${n}, sessions=${sessions}, runs=${runs})`)
    console.log('  cibles affichées à titre indicatif (recherche p95 < 100 ms @ 500k ; read --at p95 < 100 ms @ 10k msgs) — aucun gate, aucun arbitrage automatique.')
    console.log('  comparabilité : la méthode a changé le 06/10/2026 (rendu réel, snapshot, preuve géante, pic RSS OS) ; les chiffres antérieurs ne sont pas comparables à méthode égale.')
    return { tmp }
  } finally {
    // Nettoyage GARANTI même en cas d'échec ; `--keep` conserve explicitement.
    if (opts.keep) console.log(`  (conservé pour inspection : ${tmp})`)
    else {
      fs.rmSync(tmp, { recursive: true, force: true })
      console.log(`  nettoyage : ${tmp} supprimé`)
    }
  }
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) { console.log(USAGE); process.exit(0) }

main(opts).catch((e) => {
  console.error(`banc: ÉCHEC — ${e && e.message}`)
  process.exitCode = 1
})
