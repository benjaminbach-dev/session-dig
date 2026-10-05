// Test durable de la pagination opencode au-delà de 2 000 sessions (correctif lot A,
// case « adaptateur opencode en lots »). Le défaut historique : un SEUL lot de 2 000
// sessions était lu puis la boucle s'arrêtait sans index `time_updated` — les sessions
// suivantes étaient omises SILENCIEUSEMENT. `adaptPaged` pagine désormais par clé dans
// les deux plans (avec et sans index) : ce test le verrouille pour de bon.
// Fixtures synthétiques minimales, aucun message (le sujet est la pagination des sessions).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { adaptPaged } from '../src/adapter/opencode-page.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-oc-page-'))
const N = 2050
const T0 = Date.UTC(2026, 0, 1)

function buildDb (dbPath, { index }) {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session(
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, cost REAL DEFAULT 0,
      tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0
    );
    CREATE TABLE message(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
    CREATE TABLE part(
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
  `)
  const ins = db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < N; i++) ins.run(`ses_${String(i).padStart(5, '0')}`, '/root/s', `s${i}`, T0 + i, T0 + i)
  })()
  if (index) db.exec('CREATE INDEX idx_session_updated ON session(time_updated, id)')
  db.close()
  return dbPath
}

const dbNoIndex = buildDb(path.join(tmp, 'sans-index.db'), { index: false })
const dbIndex = buildDb(path.join(tmp, 'avec-index.db'), { index: true })

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function sessionsSeen (dbPath) {
  const ids = []
  await adaptPaged(dbPath, {}, {}, (batch) => { ids.push(...batch.sessions.map(s => s.id)) })
  return ids
}

for (const [label, dbPath] of [['sans index time_updated', dbNoIndex], ['avec index time_updated', dbIndex]]) {
  test(`adaptPaged ${label} : les ${N} sessions sont vues (aucune perte au-delà du premier lot de 2000)`, async () => {
    const ids = await sessionsSeen(dbPath)
    assert.equal(ids.length, N, 'toutes les sessions parcourues')
    assert.equal(new Set(ids).size, N, 'aucun doublon')
    assert.ok(ids.includes('ses_02049'), 'la dernière session (hors du premier lot) est vue')
  })
}
