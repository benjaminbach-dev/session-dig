// Suite contractuelle retriever (spec search) : tout retriever doit passer ces tests.
// v0 : bm25. v1+ : embeddings — même contrat, aucune exception.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { atomicWrite, ensureDir } from '../src/util.js'
import { index, search, name } from '../src/retriever/bm25.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-contract-'))
const root = path.join(tmp, 'corpus')
const indexPath = path.join(root, 'index.db')

const EVENTS = [
  { schemaVersion: 1, id: 'ev1', sessionId: 's1', ts: 1000, role: 'user', text: 'probleme de latence sur le endpoint api', model: { providerID: 'p', modelID: 'm' }, agent: 'build', repo: 'r1', tokens: {}, cost: 0 },
  { schemaVersion: 1, id: 'ev2', sessionId: 's1', ts: 2000, role: 'assistant', text: 'diagnostic : pool de connexions sature', model: { providerID: 'p', modelID: 'm' }, agent: 'build', repo: 'r1', tokens: {}, cost: 0, toolCalls: [{ tool: 'bash', cmd: 'curl -s localhost:9/health' }] },
  { schemaVersion: 1, id: 'ev3', sessionId: 's2', ts: 3000, role: 'user', text: 'design de la page accueil', model: { providerID: 'p', modelID: 'm2' }, agent: 'plan', repo: 'r2', tokens: {}, cost: 0 }
]

before(() => {
  ensureDir(root)
  atomicWrite(path.join(root, 'events.jsonl'), EVENTS.map(e => JSON.stringify(e)).join('\n') + '\n')
  atomicWrite(path.join(root, 'sessions.jsonl'), '')
  index(root, indexPath)
})
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

test(`contrat 1 — retriever « ${name} » : un événement indexé est retrouvable par ses mots`, () => {
  const hits = search(indexPath, { q: 'latence endpoint', limit: 10, plain: true })
  assert.ok(hits.some(h => h.id === 'ev1'), 'ev1 doit être retrouvé par « latence endpoint »')
  const hits2 = search(indexPath, { q: 'pool connexions', limit: 10, plain: true })
  assert.ok(hits2.some(h => h.id === 'ev2'))
})

test('contrat 1bis — les commandes de toolCalls sont cherchables', () => {
  const hits = search(indexPath, { q: 'curl health', limit: 10, plain: true })
  assert.ok(hits.some(h => h.id === 'ev2'))
})

test('contrat 2 — indexation idempotente : double index → mêmes résultats', () => {
  const before = search(indexPath, { q: 'latence design', limit: 10, plain: true }).map(h => h.id)
  index(root, indexPath)
  const after = search(indexPath, { q: 'latence design', limit: 10, plain: true }).map(h => h.id)
  assert.deepEqual(before, after)
})

test('contrat 3 — index jetable : suppression + réindexation depuis le seul corpus → mêmes résultats', () => {
  const before = search(indexPath, { q: 'latence design', limit: 10, plain: true })
  for (const f of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) fs.rmSync(f, { force: true })
  index(root, indexPath)
  const after = search(indexPath, { q: 'latence design', limit: 10, plain: true })
  assert.deepEqual(before, after)
})

test('contrat 4 — interface : search retourne eventId + score, ordre par rang', () => {
  const hits = search(indexPath, { q: 'design', limit: 10, plain: true })
  assert.ok(hits.length >= 1)
  assert.ok(typeof hits[0].id === 'string')
  assert.ok(typeof hits[0].score === 'number')
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score <= hits[i].score)
})
