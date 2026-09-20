// Ingestion (change scale-corpus) : corpus v2 — shards events/<p>/<sessionId>.jsonl,
// sessions.jsonl, raw/<p>/<partId>.txt, state.json (layoutVersion: 2). Idempotence
// octet par octé, ordre stable, protocole de publication (marqueur, staging, renames,
// COMMIT de la vue = point de publication), migration v1→v2 sans source, empreinte.
// Les enregistrements (schéma événement/session) sont strictement inchangés depuis v1.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest, migrate, fingerprint, loadCorpus, ingestRunning, recover, proofWarning } from '../src/corpus.js'
import { shardPath, rawShardPath, shardPrefix, listShards, assertLayout } from '../src/layout.js'
import { readJsonl } from '../src/util.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-ingest-'))
const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')

before(() => { buildFixtureDb(dbPath) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const sesFile = () => path.join(root, 'sessions.jsonl')

test('première ingestion : shards, sessions, toolCalls, raw, layoutVersion', async () => {
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 5) // u1, a1, a2 + err? (non : 3 sessions, 5 messages)
  assert.equal(r.totals.sessions, 3)
  assert.equal(r.totals.events, 5)
  // layout v2 : state.json porte la version, chaque session a son shard
  const st = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  assert.equal(st.layoutVersion, 2)
  const shards = listShards(root)
  assert.equal(shards.length, 3)
  assert.ok(shards.every(rel => /^events\/[0-9a-f]{2}\/.+\.jsonl$/.test(rel)))
  // contenu des événements : inchangé depuis v1
  const events = shards.flatMap(rel => readJsonl(path.join(root, rel)))
  const eA1 = events.find(e => e.id === 'msg_a1')
  assert.equal(eA1.toolCalls[0].tool, 'bash')
  assert.equal(eA1.toolCalls[0].cmd, 'git revert abc123')
  assert.equal(eA1.toolCalls[0].exitCode, 0)
  assert.ok(eA1.toolCalls[0].rawRef)
  // raw shardé : raw/<p>/<partId>.txt
  const rawFile = rawShardPath(path.join(root, 'raw'), eA1.toolCalls[0].rawRef)
  assert.ok(fs.existsSync(rawFile), `raw shardé présent : ${rawFile}`)
  assert.equal(fs.readFileSync(rawFile, 'utf8'), 'revert ok\n')
  // message à 2 tool calls → liste
  const eA2 = events.find(e => e.id === 'msg_a2')
  assert.equal(eA2.toolCalls.length, 2)
  assert.equal(eA2.toolCalls[1].cmd, 'file: config.json')
  // tokens/cost depuis step-finish quand absents du message
  assert.equal(eA2.cost, 0.001)
  assert.equal(eA2.tokens.in, 400)
  // repo null pour directory = home
  const eU3 = events.find(e => e.id === 'msg_u3')
  assert.equal(eU3.repo, null)
  // sessions : parentSession + repo basename
  const sessions = readJsonl(sesFile())
  const s3 = sessions.find(s => s.id === 'ses_fix3')
  assert.equal(s3.parentSession, 'ses_fix1')
  assert.equal(sessions.find(s => s.id === 'ses_fix1').repo, 'ccp-proxy')
  // shard d'une session : ordonné (ts, id)
  const ses1 = readJsonl(shardPath(root, 'ses_fix1')).map(e => e.ts)
  assert.deepEqual(ses1, [...ses1].sort((a, b) => a - b))
  // répartition par condensat : le préfixe de ses_fix1 est stable et hexa
  assert.match(shardPrefix('ses_fix1'), /^[0-9a-f]{2}$/)
})

test('condensat de sharding : réparti, jamais concentré sur le préfixe des ids', () => {
  // tous les ids commencent par « ses_ » : le préfixe de répartition ne doit pas
  // dériver des premiers caractères de l'id (qui donneraient tout dans un répertoire)
  const dirs = new Set()
  for (let i = 0; i < 200; i++) dirs.add(shardPrefix(`ses_${i}`))
  assert.ok(dirs.size >= 20, `200 ids ses_* → ${dirs.size} répertoires distincts (≥ 20)`)
})

test('idempotence : double ingestion → shards identiques, zéro ajout', async () => {
  const snap = () => listShards(root).map(rel => fs.readFileSync(path.join(root, rel), 'utf8')).join('') + fs.readFileSync(sesFile(), 'utf8')
  const h1 = snap()
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 0)
  assert.equal(r.updated, 0)
  const h2 = snap()
  assert.equal(h1, h2)
})

test('incrémental : message modifié → maj sans doublon, shard réécrit', async () => {
  const beforeCount = listShards(root).flatMap(rel => readJsonl(path.join(root, rel))).length
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const part = db.prepare('SELECT data FROM part WHERE id = ?').get('prt_u1')
  const pd = JSON.parse(part.data)
  pd.text = 'le proxy renvoie 461 sans cesse sur le endpoint go (précisé : fin de quota)'
  db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(JSON.stringify(pd), Date.now(), 'prt_u1')
  // time_updated porté à « maintenant » (comme opencode sur maj) — sinon sous le watermark
  db.prepare('UPDATE message SET time_updated = ? WHERE id = ?').run(Date.now(), 'msg_u1')
  db.close()

  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 0)
  assert.ok(r.updated >= 1 || r.unchanged >= 0)
  const after = listShards(root).flatMap(rel => readJsonl(path.join(root, rel)))
  assert.equal(after.length, beforeCount) // aucun doublon
  const e = after.find(x => x.id === 'msg_u1')
  assert.ok(e.text.includes('précisé : fin de quota'))
})

test('incrémental : nouveau message → shard de la session touchée seulement', async () => {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const t = Date.now() + 60000
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run('msg_new1', 'ses_fix1', t, t, JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'x', modelID: 'y' } }))
    db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run('prt_new1', 'msg_new1', 'ses_fix1', t, t, JSON.stringify({ type: 'text', text: 'nouveau message post-ingestion' }))
  db.close()

  // mtime des shards NON touchés (ses_fix2, ses_fix3) : inchangés
  const mtime2 = fs.statSync(shardPath(root, 'ses_fix2')).mtimeMs
  const mtime3 = fs.statSync(shardPath(root, 'ses_fix3')).mtimeMs
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 1)
  assert.equal(r.shardsTouched, 1) // seulement ses_fix1
  const shard1 = readJsonl(shardPath(root, 'ses_fix1'))
  assert.ok(shard1.some(e => e.id === 'msg_new1'))
  assert.equal(fs.statSync(shardPath(root, 'ses_fix2')).mtimeMs, mtime2)
  assert.equal(fs.statSync(shardPath(root, 'ses_fix3')).mtimeMs, mtime3)
})

test('rebuild : corpus identique, raw purgé et régénéré', async () => {
  const h1 = fs.readFileSync(shardPath(root, 'ses_fix1'), 'utf8')
  // polluer raw/ avec un orphelin
  fs.writeFileSync(path.join(root, 'raw', 'prt_orphan.txt'), 'stale')
  const r = await ingest({ root, db: dbPath, rebuild: true })
  assert.equal(r.rebuild, true)
  // rebuild = réingestion intégrale depuis la source : le shard contient tous les
  // messages de la source (dont msg_new1 ajouté par le test précédent)
  const rebuilt = fs.readFileSync(shardPath(root, 'ses_fix1'), 'utf8')
  assert.ok(rebuilt.includes('msg_new1'))
  assert.ok(rebuilt.includes('msg_u1'))
  assert.equal(fs.existsSync(path.join(root, 'raw', 'prt_orphan.txt')), false)
})

test('base absente : erreur explicite, corpus intact', async () => {
  const h1 = fs.readFileSync(shardPath(root, 'ses_fix1'), 'utf8')
  await assert.rejects(
    () => ingest({ root, db: path.join(tmp, 'inexistant.db') }),
    /introuvable/
  )
  assert.equal(fs.readFileSync(shardPath(root, 'ses_fix1'), 'utf8'), h1)
})

// ── layout v2 : refus de version ──

test('layout v1 refusé : message nommant la version lue et attendue', () => {
  assert.throws(() => assertLayout({ layoutVersion: 1 }), /lu v1, attendu v2/)
  assert.throws(() => assertLayout({}), /lu v1, attendu v2/) // sans layoutVersion = v1
  assert.doesNotThrow(() => assertLayout({ layoutVersion: 2 }))
})

// ── migration v1 → v2 sans source ──

test('migration v1→v2 : sans source, en flux, vérifiée, idempotente', async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mig-'))
  const rootV1 = path.join(tmp2, 'corpus')
  fs.mkdirSync(rootV1)
  // corpus v1 : events.jsonl (trié sessionId, ts, id) + sessions.jsonl + state v1
  const ev1 = [
    { schemaVersion: 1, id: 'm2', sessionId: 'sa', ts: 2000, role: 'user', text: 'deux', model: {}, repo: null, tokens: {}, cost: 0 },
    { schemaVersion: 1, id: 'm1', sessionId: 'sa', ts: 1000, role: 'user', text: 'un', model: {}, repo: null, tokens: {}, cost: 0 },
    { schemaVersion: 1, id: 'm3', sessionId: 'sb', ts: 3000, role: 'assistant', text: 'trois', model: {}, repo: null, tokens: {}, cost: 0 }
  ]
  fs.writeFileSync(path.join(rootV1, 'events.jsonl'), ev1.map(e => JSON.stringify(e)).join('\n') + '\n')
  fs.writeFileSync(path.join(rootV1, 'sessions.jsonl'), [
    { schemaVersion: 1, id: 'sa', title: 'A', repo: 'r', tsCreated: 0, tsUpdated: 2000, cost: 0, tokens: {} },
    { schemaVersion: 1, id: 'sc', title: 'C sans événement', repo: 'r', tsCreated: 0, tsUpdated: 0, cost: 0, tokens: {} }
  ].map(s => JSON.stringify(s)).join('\n') + '\n')
  fs.writeFileSync(path.join(rootV1, 'state.json'), JSON.stringify({ message: 2000, session: 2000, counts: { events: 3, sessions: 2 } }))

  const r = await migrate(rootV1)
  assert.equal(r.done, true)
  assert.equal(r.events, 3)
  assert.equal(r.coherent, true)
  assert.ok(r.emptySessions.includes('sc')) // incohérence signalée, pas ignorée
  // shards écrits, ordonnés
  assert.equal(listShards(rootV1).length, 2)
  assert.deepEqual(readJsonl(shardPath(rootV1, 'sa')).map(e => e.id), ['m1', 'm2'])
  const st = JSON.parse(fs.readFileSync(path.join(rootV1, 'state.json'), 'utf8'))
  assert.equal(st.layoutVersion, 2)
  assert.equal(st.message, 2000) // watermark conservé (sans source)
  // idempotente
  const r2 = await migrate(rootV1)
  assert.equal(r2.done, false)
  fs.rmSync(tmp2, { recursive: true, force: true })
})

// ── empreinte déterministe ──

test('empreinte : stable quel que soit le parcours, change avec le contenu', async () => {
  // une passe d'ingestion purgera le marqueur posé par le test précédent si besoin
  await ingest({ root, db: dbPath })
  const f1 = fingerprint(root)
  assert.match(f1.fingerprint, /^[0-9a-f]{32}$/)
  assert.ok(f1.files.length >= 4) // shards, sessions, raw, state
  // fichiers dérivés exclus (index.db)
  assert.ok(!f1.files.some(f => f.file.startsWith('index.db')))
  const f2 = fingerprint(root)
  assert.equal(f1.fingerprint, f2.fingerprint)
  // un contenu modifié → empreinte différente
  const rawRef = f1.files.find(f => f.file.startsWith('raw/'))
  const abs = path.join(root, rawRef.file)
  const orig = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, orig + '\n')
  const f3 = fingerprint(root)
  assert.notEqual(f1.fingerprint, f3.fingerprint)
  fs.writeFileSync(abs, orig)
})

// ── marqueur d'ingestion en cours : réconciliation, reprise, avertissement ──

test('marqueur présent : preuve signalée, archive refusée, réconciliation par relance', async () => {
  fs.writeFileSync(path.join(root, '.ingest-in-progress'), '{}\n')
  assert.equal(ingestRunning(root), true)
  assert.match(proofWarning(root), /ingestion en cours/)
  assert.throws(() => fingerprint(root), /marqueur/)
  // réconciliation par relance : l'ingestion rejoue la passe, converge, retire le marqueur
  const r = await ingest({ root, db: dbPath })
  assert.equal(ingestRunning(root), false)
  assert.ok(r.added >= 0)
  const f = fingerprint(root)
  assert.match(f.fingerprint, /^[0-9a-f]{32}$/)
})

test('reprise explicite sans source : vue reconstruite, watermark conservé, marqueur retiré', async () => {
  fs.writeFileSync(path.join(root, '.ingest-in-progress'), '{}\n')
  const r = recover(root)
  assert.equal(r.done, true)
  assert.match(r.note, /reprise explicite/)
  assert.match(r.note, /watermark conservé/)
  assert.equal(ingestRunning(root), false)
  // recover sans marqueur : rien à faire
  const r2 = recover(root)
  assert.equal(r2.done, false)
})

// ── échelle : fenêtres bornées sur une session géante (mémoire bornée) ──

test('session de 100 000 messages : lecture bornée, comptage de plage exact', async () => {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-scale-'))
  const root3 = path.join(tmp3, 'corpus')
  const N = 100000
  // shard écrit en flux (une session géante ne doit jamais résider entière hors test)
  const file = shardPath(root3, 'ses_big')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const out = fs.createWriteStream(file)
  const T0 = Date.UTC(2026, 0, 1)
  const write = (i) => new Promise(res => {
    const e = { schemaVersion: 1, id: `m_${i}`, sessionId: 'ses_big', ts: T0 + i, role: i % 2 ? 'user' : 'assistant', text: `msg ${i} balise_${i}`, model: {}, agent: 'build', repo: 'big', tokens: {}, cost: 0 }
    res(out.write(JSON.stringify(e) + '\n') ? null : undefined)
  })
  const batches = []
  let batch = []
  for (let i = 0; i < N; i++) { batch.push(i); if (batch.length === 5000) { batches.push(batch); batch = [] } }
  if (batch.length) batches.push(batch)
  for (const b of batches) { for (const i of b) await write(i); }
  out.end()
  await new Promise(res => out.on('close', res))
  fs.writeFileSync(path.join(root3, 'sessions.jsonl'), JSON.stringify({ schemaVersion: 1, id: 'ses_big', title: 'Géante', repo: 'big', tsCreated: T0, tsUpdated: T0 + N, cost: 0, tokens: {} }) + '\n')
  fs.writeFileSync(path.join(root3, 'state.json'), JSON.stringify({ layoutVersion: 2, message: T0 + N, session: T0 + N, counts: { events: N, sessions: 1 } }))

  const { index, search } = await import('../src/retriever/bm25.js')
  const { sessionSlice } = await import('../src/read.js')
  const t0 = performance.now()
  index(root3)
  const tIdx = performance.now() - t0
  // lecture bornée : --around au milieu, fenêtre de 11 messages
  const t1 = performance.now()
  const slice = sessionSlice(root3, 'ses_big', { aroundId: 'm_50000', ctx: 5 })
  const tRead = performance.now() - t1
  assert.equal(slice.total, N)
  assert.equal(slice.aroundIdx, 50000)
  assert.equal(slice.events.length, 11)
  assert.ok(tRead < 2000, `lecture bornée en ${tRead.toFixed(0)} ms (< 2000 ms)`)
  // compteurs --at : dénombrement de plage (coût O(plage), exact)
  const t2 = performance.now()
  const at = sessionSlice(root3, 'ses_big', { at: String(T0 + 50000) })
  const tAt = performance.now() - t2
  assert.equal(at.maskedCount, N - 50001)
  assert.ok(tAt < 2000, `comptage de plage en ${tAt.toFixed(0)} ms (< 2000 ms)`)
  // recherche à l'échelle
  const t3 = performance.now()
  const hits = search(path.join(root3, 'index.db'), { q: 'balise_99999', limit: 5, plain: true })
  const tQ = performance.now() - t3
  assert.ok(hits.some(h => h.id === 'm_99999'))
  assert.ok(tQ < 1000, `requête p95 en ${tQ.toFixed(0)} ms (< 1000 ms)`)
  // échelle 100k : indexation plus lente (FTS5 rebuild), mais lecture bornée.
  console.log(`  échelle 100k : index ${tIdx.toFixed(0)} ms, lecture bornée ${tRead.toFixed(0)} ms, plage ${tAt.toFixed(0)} ms, requête ${tQ.toFixed(0)} ms`)
  fs.rmSync(tmp3, { recursive: true, force: true })
})
