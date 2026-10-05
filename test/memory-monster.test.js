// Mesure mémoire sur fixture (correctif lot A, case « tests dédiés ») : l'ingestion
// d'une session « monstre » ne doit PAS matérialiser le corpus entier de façon
// grotesque. La borne choisie est VOLONTAIREMENT LARGE (256 Mio de delta RSS) :
// elle est anti-flaky — son but est de détecter une matérialisation complète
// démesurée (ex. accumulation du delta au lieu d'une session), pas de mesurer
// précisément une empreinte. Le design D4 annonce des coûts restants explicites
// (session en cours, delta) : ce test ne les nie pas, il borne le pire accident.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ingest } from '../src/corpus.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-memory-'))
// source pi hermétique (jamais le ~/.pi réel dans les tests)
const __prevPiDir = process.env.SESSION_DIG_PI_DIR
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-absente')

const dbPath = path.join(tmp, 'monstre.db')
const root = path.join(tmp, 'corpus')
const MSG_COUNT = 300
const TEXT_LEN = 20000

before(() => {
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
  const T0 = Date.UTC(2026, 0, 1)
  const big = 'x'.repeat(TEXT_LEN)
  const insSes = db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)')
  const insMsg = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
  const insPart = db.prepare('INSERT INTO part (id, message_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    insSes.run('ses_monstre', '/root/monstre', 'Session monstre', T0, T0 + MSG_COUNT)
    for (let i = 0; i < MSG_COUNT; i++) {
      const id = `msg_${String(i).padStart(4, '0')}`
      const ts = T0 + i
      insMsg.run(id, 'ses_monstre', ts, ts, JSON.stringify({ role: i % 2 ? 'user' : 'assistant', agent: 'build' }))
      insPart.run(`prt_${i}`, id, ts, ts, JSON.stringify({ type: 'text', text: `${big} (${i})` }))
    }
  })()
  db.close()
})

after(() => {
  if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = __prevPiDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('ingestion d’une session monstre : RSS borné (delta < 256 Mio, borne lâche)', { timeout: 30000 }, async () => {
  const before = process.memoryUsage().rss
  const r = await ingest({ root, db: dbPath })
  const after = process.memoryUsage().rss
  assert.equal(r.totals.events, MSG_COUNT, 'tous les messages ingérés')
  const deltaMio = (after - before) / (1024 * 1024)
  console.log(`  mémoire monstre : delta RSS ${deltaMio.toFixed(1)} Mio pour ~${((MSG_COUNT * TEXT_LEN) / 1e6).toFixed(1)} Mo de texte`)
  // borne anti-flaky : large à dessein (voir en-tête du fichier)
  assert.ok(deltaMio < 256, `delta RSS ${deltaMio.toFixed(1)} Mio < 256 Mio (texte ~${((MSG_COUNT * TEXT_LEN) / 1e6).toFixed(1)} Mo)`)
})
