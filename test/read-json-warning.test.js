// Correctif préexistant `read --json` : l'avertissement de publication (marqueur
// d'ingestion non réconcilié) ne SHALL PAS préfixer le JSON sur stdout. Fixtures
// 100 % synthétiques, corps temporaire jetable ; source pi explicitement sous le
// tmp du test, jamais le ~/.pi réel. Le marqueur est posé APRÈS une ingestion
// réconciliée : la vue reste fraîche (la lecture passe bien par openView) — le
// marqueur signale une publication possible, il ne garantit pas à lui seul la
// fraîcheur, et ces tests ne contournent jamais openView.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildFixtureDb } from './helpers/fixture.js'
import {
  T0 as T0PI, fakeUuid, sessionLine, messageLine, infoLine, writePiSession
} from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { markerPath } from '../src/layout.js'

const cli = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-read-json-warn-'))
const __prevPiDir = process.env.SESSION_DIG_PI_DIR

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi')
process.env.SESSION_DIG_PI_DIR = piDir

// Texte d'avertissement réellement produit par proofWarning (src/corpus.js).
const WARN = 'ingestion en cours non réconciliée'

const text = (s) => ({ type: 'text', text: s })
let piUuid = null
const piSessionId = () => `pi:${piUuid}`

before(async () => {
  buildFixtureDb(dbPath)
  piUuid = fakeUuid()
  writePiSession(piDir, 'proj-warn', 'ses_warn.jsonl', [
    sessionLine(piUuid, T0PI, '/root/proj-warn'),
    infoLine(T0PI + 10, 'Session pi avertissement', 'infW'),
    messageLine(T0PI + 1000, {
      role: 'user',
      content: [text('question pi sur le marqueur')],
      timestamp: T0PI + 100
    }),
    messageLine(T0PI + 2000, {
      role: 'assistant',
      content: [text('réponse pi sur le marqueur')],
      provider: 'antho',
      model: 'sonnet-x',
      timestamp: T0PI + 1500
    })
  ])
  await ingest({ root, db: dbPath, piDir })
})

after(() => {
  if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = __prevPiDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

function run (args) {
  return spawnSync(process.execPath, [cli, ...args, '--home', root], {
    env: { ...process.env, SESSION_DIG_HOME: root },
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8 << 20
  })
}

function setMarker () {
  fs.writeFileSync(markerPath(root),
    JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }) + '\n')
}

function clearMarker () {
  fs.rmSync(markerPath(root), { force: true })
}

// ── Sans marqueur : référence (aucun avertissement nulle part) ──

test('sans marqueur : read --json → code 0, stdout JSON, stderr vide', () => {
  clearMarker()
  const r = run(['read', 'ses_fix1', '--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '', 'aucun avertissement sans marqueur')
  const j = JSON.parse(r.stdout)
  assert.ok(j.messages.length > 0)
  assert.ok(!r.stdout.includes(WARN))
})

test('sans marqueur : read pi --json → fidelity présent, stderr vide', () => {
  clearMarker()
  const r = run(['read', piSessionId(), '--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
  const j = JSON.parse(r.stdout)
  assert.equal(j.fidelity.source, 'pi')
  assert.ok(j.fidelity.limits.length >= 2)
})

// ── Avec marqueur artificiel : stdout = JSON unique, avertissement sur stderr ──

test('marqueur : read --json → stdout JSON unique valide, avertissement stderr, comptes/contenus préservés', () => {
  clearMarker()
  const base = JSON.parse(run(['read', 'ses_fix1', '--json']).stdout)
  setMarker()
  try {
    const r = run(['read', 'ses_fix1', '--json'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes('⚠'), 'aucun décor/avertissement sur stdout')
    assert.ok(!r.stdout.includes(WARN), 'avertissement absent du JSON')
    assert.ok(r.stderr.includes(WARN), 'avertissement toujours visible, routé sur stderr')
    const j = JSON.parse(r.stdout) // lève si le stdout n'est pas un unique document JSON
    assert.deepEqual(j, base, 'contenu, comptes et forme JSON inchangés')
  } finally {
    clearMarker()
  }
})

test('marqueur : read pi --json → fidelity et contenus préservés, avertissement stderr', () => {
  clearMarker()
  const base = JSON.parse(run(['read', piSessionId(), '--json']).stdout)
  assert.equal(base.fidelity.source, 'pi')
  setMarker()
  try {
    const r = run(['read', piSessionId(), '--json'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes(WARN), 'avertissement absent du JSON')
    assert.ok(r.stderr.includes(WARN), 'avertissement visible sur stderr')
    const j = JSON.parse(r.stdout)
    assert.deepEqual(j, base, 'contenu et fidelity pi inchangés')
    assert.equal(j.fidelity.source, 'pi')
  } finally {
    clearMarker()
  }
})

// ── Terminal sans --json : comportement conservé (avertissement sur stdout) ──

test('marqueur : read terminal conserve l’avertissement sur stdout, stderr vide', () => {
  setMarker()
  try {
    const oc = run(['read', 'ses_fix1'])
    assert.equal(oc.status, 0, oc.stderr)
    assert.ok(oc.stdout.includes(WARN), 'avertissement visible en terminal opencode')
    assert.equal(oc.stderr, '')
    assert.ok(oc.stdout.includes('proxy 461') || oc.stdout.includes('461'), 'session toujours rendue')

    const pi = run(['read', piSessionId()])
    assert.equal(pi.status, 0, pi.stderr)
    assert.ok(pi.stdout.includes(WARN), 'avertissement visible en terminal pi')
    assert.equal(pi.stderr, '')
  } finally {
    clearMarker()
  }
})

test('sans marqueur : read terminal n’affiche pas l’avertissement', () => {
  clearMarker()
  const r = run(['read', 'ses_fix1'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stdout.includes(WARN))
})
