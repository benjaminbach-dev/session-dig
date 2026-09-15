import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest } from '../src/corpus.js'
import { readJsonl } from '../src/util.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-ingest-'))
const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')

before(() => { buildFixtureDb(dbPath) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const evFile = () => path.join(root, 'events.jsonl')
const sesFile = () => path.join(root, 'sessions.jsonl')

test('première ingestion : events, sessions, toolCalls, raw', async () => {
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 5) // u1, a1, a2 (user/assistant/user/assistant/user)
  assert.equal(r.totals.sessions, 3)
  const events = readJsonl(evFile())
  const eA1 = events.find(e => e.id === 'msg_a1')
  assert.equal(eA1.toolCalls[0].tool, 'bash')
  assert.equal(eA1.toolCalls[0].cmd, 'git revert abc123')
  assert.equal(eA1.toolCalls[0].exitCode, 0)
  assert.ok(eA1.toolCalls[0].rawRef)
  const rawFile = path.join(root, 'raw', `${eA1.toolCalls[0].rawRef}.txt`)
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
})

test('idempotence : double ingestion → fichiers identiques, zéro ajout', async () => {
  const h1 = fs.readFileSync(evFile(), 'utf8') + fs.readFileSync(sesFile(), 'utf8')
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 0)
  assert.equal(r.updated, 0)
  const h2 = fs.readFileSync(evFile(), 'utf8') + fs.readFileSync(sesFile(), 'utf8')
  assert.equal(h1, h2)
})

test('incrémental : message modifié → maj sans doublon', async () => {
  const before = readJsonl(evFile())
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const data = JSON.parse(db.prepare('SELECT data FROM message WHERE id = ?').get('msg_u1').data)
  const part = db.prepare('SELECT data FROM part WHERE id = ?').get('prt_u1')
  const pd = JSON.parse(part.data)
  pd.text = 'le proxy renvoie 461 sans cesse sur le endpoint go (précisé : fin de quota)'
  db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(JSON.stringify(pd), Date.now(), 'prt_u1')
  // time_updated porté à « maintenant » (comme le fait réellement opencode sur maj)
  // — un simple +5000 resterait sous le watermark global et ne serait pas relu.
  db.prepare('UPDATE message SET time_updated = ? WHERE id = ?').run(Date.now(), 'msg_u1')
  // le message n'est pas réémis tel quel : data inchangé mais time_updated bouge → relu
  db.close()

  const r = await ingest({ root, db: dbPath })
  const after = readJsonl(evFile())
  assert.equal(after.length, before.length) // aucun doublon
  const e = after.find(x => x.id === 'msg_u1')
  assert.ok(e.text.includes('précisé : fin de quota'))
})

test('incrémental : nouveau message → ajouté', async () => {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const t = Date.UTC(2026, 8, 16)
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run('msg_new1', 'ses_fix1', t, t, JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'x', modelID: 'y' } }))
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run('prt_new1', 'msg_new1', 'ses_fix1', t, t, JSON.stringify({ type: 'text', text: 'nouveau message post-ingestion' }))
  db.close()

  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 1)
  assert.ok(readJsonl(evFile()).some(e => e.id === 'msg_new1'))
})

test('rebuild : corpus identique, raw purgé et régénéré', async () => {
  const h1 = fs.readFileSync(evFile(), 'utf8')
  // polluer raw/ avec un orphelin
  fs.writeFileSync(path.join(root, 'raw', 'prt_orphan.txt'), 'stale')
  const r = await ingest({ root, db: dbPath, rebuild: true })
  assert.equal(r.rebuild, true)
  assert.equal(fs.readFileSync(evFile(), 'utf8'), h1)
  assert.equal(fs.existsSync(path.join(root, 'raw', 'prt_orphan.txt')), false)
  assert.ok(fs.readdirSync(path.join(root, 'raw')).length > 0)
})

test('base absente : erreur explicite, corpus intact', async () => {
  const h1 = fs.readFileSync(evFile(), 'utf8')
  await assert.rejects(
    () => ingest({ root, db: path.join(tmp, 'inexistant.db') }),
    /introuvable/
  )
  assert.equal(fs.readFileSync(evFile(), 'utf8'), h1)
})
