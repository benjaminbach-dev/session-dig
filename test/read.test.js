// Lecture du contexte + preuve (retour d'agent 16/09) : voisinage, fenêtres, raw.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { mergeWindows, sessionSlice, eventsBySession } from '../src/read.js'
import { rawScan } from '../src/raw.js'
import { renderRead, renderTerminal } from '../src/format.js'
import { loadCorpus } from '../src/corpus.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-read-'))
const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const indexPath = path.join(root, 'index.db')

before(async () => {
  buildFixtureDb(dbPath)
  await ingest({ root, db: dbPath })
  index(root, indexPath)
})
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

test('mergeWindows : fenêtres fusionnées et bornées', () => {
  // hits aux index 2 et 5, ctx 1 → [1,3] et [4,6] adjacentes → fusionnées (pas de trou)
  assert.deepEqual(mergeWindows(10, [2, 5], 1), [[1, 6]])
  // fenêtres disjointes (trou d'au moins 1 message) → conservées séparées
  assert.deepEqual(mergeWindows(10, [2, 6], 1), [[1, 3], [5, 7]])
  // bornes : hit 0 ctx 2 → [0,2]
  assert.deepEqual(mergeWindows(10, [0], 2), [[0, 2]])
})

test('sessionSlice : --around ressort la fenêtre et le message visé', () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_a1', ctx: 1 })
  assert.ok(slice)
  assert.equal(slice.aroundIdx, 1) // u1, a1, a2 → a1 à l'index 1
  assert.deepEqual(slice.spans, [[0, 2]])
  const out = renderRead(slice, 'ses_fix1')
  assert.ok(out.includes('►')) // le message visé est marqué
  assert.ok(out.includes('461')) // voisin u1 visible
})

test('sessionSlice : session inconnue → null ; --tail borne la fin', () => {
  assert.equal(sessionSlice(root, 'ses_xxx', {}), null)
  const slice = sessionSlice(root, 'ses_fix1', { tail: 2 })
  assert.deepEqual(slice.spans, [[1, 2]])
})

test('recherche --ctx : les voisins du hit apparaissent, hits marqués ►', () => {
  const hits = search(indexPath, { q: 'timeout upstream', limit: 5, plain: true })
  const { events, sessionsById } = loadCorpus(root)
  const evs = eventsBySession(events)
  const out = renderTerminal(hits, sessionsById, { ctx: 1, eventsBySession: evs, plain: true })
  assert.ok(out.includes('►')) // hit marqué
  assert.ok(out.includes('461')) // voisin avant
  assert.ok(out.includes('Je relance')) // voisin après
  assert.ok(out.includes('git revert')) // cmd du toolCall visible dans le contexte
})

test('recherche --ctx : hits proches → fenêtre fusionnée, pas de doublon', () => {
  const hits = search(indexPath, { q: 'proxy timeout', limit: 5, plain: true })
  const { events, sessionsById } = loadCorpus(root)
  const evs = eventsBySession(events)
  const out = renderTerminal(hits, sessionsById, { ctx: 2, eventsBySession: evs, plain: true })
  // u1 rendu une seule fois (le titre de session contient aussi « 461 » — on compte le texte, pas le titre)
  assert.equal(out.split('renvoie').length - 1, 1)
  assert.equal(out.split('Je relance').length - 1, 1) // voisin a2 affiché une fois
})

test('rawScan : trouve une erreur qui n\'existe que dans la sortie brute', async () => {
  // ajouter une sortie brute avec stderr typique sur un nouveau message
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const t = Date.now()
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run('msg_err1', 'ses_fix1', t, t, JSON.stringify({ role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm' }))
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run('prt_err1', 'msg_err1', 'ses_fix1', t, t, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'go test ./...' }, output: 'FAIL: TestUpstream [stderr] connection refused 461\nexit status 1', metadata: { exitCode: 1 } } }))
  db.close()
  await ingest({ root, db: dbPath })
  index(root, indexPath)

  const hits = search(indexPath, { q: 'connection refused', limit: 5, plain: true })
  assert.equal(hits.length, 0) // pas dans l'index BM25 (spec : bruit exclu)
  const raw = rawScan(root, 'connection refused', { limit: 5 })
  assert.equal(raw.length, 1)
  assert.equal(raw[0].rawRef, 'prt_err1')
  assert.equal(raw[0].sessionId, 'ses_fix1')
  assert.ok(raw[0].line.includes('connection refused'))
  assert.equal(raw[0].tool, 'bash')
})

async function await_loadCorpus () {
  const { loadCorpus } = await import('../src/corpus.js')
  return loadCorpus(root)
}
