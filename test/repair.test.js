// Corrections locales post-revue : petits corpus, aucun banc volumineux.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest, recover, CorpusLock } from '../src/corpus.js'
import { search } from '../src/retriever/bm25.js'
import { streamLines } from '../src/util.js'

async function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-repair-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const root = path.join(tmp, 'corpus'), source = path.join(tmp, 'source.db')
  buildFixtureDb(source)
  await ingest({ root, db: source })
  return { tmp, root, source, state: path.join(root, 'state.json'), view: path.join(root, 'index.db') }
}
for (const missing of [true, false]) {
  test(`réparation vue ${missing ? 'absente' : 'périmée'} + modification événement/titre : FTS cohérent`, async t => {
    const f = await fixture(t)
    if (missing) for (const ext of ['', '-wal', '-shm']) fs.rmSync(f.view + ext, { force: true })
    else {
      const v = new Database(f.view)
      v.prepare('UPDATE watermark SET message=-1, session=-1').run(); v.close()
    }
    const db = new Database(f.source), up = Date.now() + 60000
    const part = JSON.parse(db.prepare('SELECT data FROM part WHERE id=?').get('prt_u1').data)
    part.text = 'nouveautecible unique'
    db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(part), 'prt_u1')
    db.prepare('UPDATE message SET time_updated=? WHERE id=?').run(up, 'msg_u1')
    db.prepare('UPDATE session SET title=?, time_updated=? WHERE id=?').run('titrecible unique', up, 'ses_fix1')
    db.close()
    const r = await ingest({ root: f.root, db: f.source })
    assert.equal(r.totals.events, 5)
    assert.ok(search(f.view, { q: 'nouveautecible' }).some(h => h.id === 'msg_u1'))
    assert.ok(search(f.view, { q: 'titrecible' }).some(h => h.id === 'ses_fix1'))
    assert.ok(search(f.view, { q: 'palette' }).some(h => h.id === 'msg_u2'))
  })
}
test('reprise post-COMMIT : les compteurs rattrapent la vue publiée', async t => {
  const f = await fixture(t), oldState = fs.readFileSync(f.state)
  const db = new Database(f.source), up = Date.now() + 60000
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('msg_plus', 'ses_fix1', up, up, JSON.stringify({ role: 'user' }))
  db.close()
  assert.equal((await ingest({ root: f.root, db: f.source })).totals.events, 6)
  fs.writeFileSync(f.state, oldState)
  fs.writeFileSync(path.join(f.root, '.ingest-in-progress'), '{}')
  const r = await ingest({ root: f.root, db: f.source })
  assert.equal(r.added, 0)
  assert.equal(r.totals.events, 6)
  assert.equal(JSON.parse(fs.readFileSync(f.state)).counts.events, 6)
})
test('recover restaure les comptes avant de retirer le marqueur', async t => {
  const f = await fixture(t)
  const st = JSON.parse(fs.readFileSync(f.state)); st.counts = { events: 0, sessions: 0 }
  fs.writeFileSync(f.state, JSON.stringify(st))
  fs.writeFileSync(path.join(f.root, '.ingest-in-progress'), '{}')
  recover(f.root)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).counts, { events: 5, sessions: 3 })
  assert.equal((await ingest({ root: f.root, db: f.source })).totals.events, 5)
})
test('verrou vivant ancien : jamais repris sur son âge', async t => {
  const f = await fixture(t), file = path.join(f.tmp, 'lock')
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }))
  fs.utimesSync(file, new Date(0), new Date(0))
  assert.equal(new CorpusLock(file).acquire(), false)
  assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid)
})
test('streamLines : arrêt anticipé sans double fermeture', async t => {
  const f = await fixture(t), file = path.join(f.tmp, 'lines')
  fs.writeFileSync(file, 'a\nb\n')
  assert.equal(streamLines(file, () => false), 1)
})
test('rebuild ignore l’archive v1 conservée après migration', async t => {
  const f = await fixture(t)
  fs.writeFileSync(path.join(f.root, 'events.jsonl'), JSON.stringify({ id: 'ghost', sessionId: 'ses_fix1', ts: 1, role: 'user', text: 'fantomecible' }) + '\n')
  const r = await ingest({ root: f.root, db: f.source, rebuild: true })
  assert.equal(r.totals.events, 5)
  assert.equal(search(f.view, { q: 'fantomecible' }).length, 0)
})
