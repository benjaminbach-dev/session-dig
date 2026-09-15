import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { parseDateBound } from '../src/util.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-search-'))
const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const indexPath = path.join(root, 'index.db')

before(async () => {
  buildFixtureDb(dbPath)
  await ingest({ root, db: dbPath })
  index(root, indexPath)
})
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// Requêtes dorées : la session attendue doit sortir en tête (spec search).
test('dorée : « proxy 461 » → ses_fix1', () => {
  const hits = search(indexPath, { q: 'proxy 461', limit: 10, plain: true })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].session_id, 'ses_fix1')
  assert.ok(hits[0].snip.includes('461'))
})

test('dorée : « timeout upstream » → ses_fix1', () => {
  const hits = search(indexPath, { q: 'timeout upstream', limit: 10, plain: true })
  assert.equal(hits[0].session_id, 'ses_fix1')
})

test('dorée : « palette lila » → ses_fix2', () => {
  const hits = search(indexPath, { q: 'palette lila', limit: 10, plain: true })
  assert.equal(hits[0].session_id, 'ses_fix2')
})

test('dorée : commande « git revert » trouvée via cmd (toolCall indexé)', () => {
  const hits = search(indexPath, { q: 'git revert', limit: 10, plain: true })
  assert.ok(hits.some(h => h.id === 'msg_a1'))
  const hit = hits.find(h => h.id === 'msg_a1')
  // les marqueurs « » encadrent chaque terme : on les retire avant de vérifier
  const snip = hit.snipCmd.replaceAll('»', '').replaceAll('«', '')
  assert.ok(snip.includes('git') && snip.includes('revert'))
})

test('repli OR : termes dispersés ne retournent pas vide', () => {
  // « revert lila » : aucun event ne contient les deux, OR doit trouver des hits
  const hits = search(indexPath, { q: 'revert lila', limit: 10, plain: true })
  assert.ok(hits.length >= 2)
})

test('filtre --repo exclut les autres sessions', () => {
  const hits = search(indexPath, { q: 'proxy palette', repo: 'theme-kit', limit: 10, plain: true })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every(h => h.repo === 'theme-kit'))
})

test('filtre --session par préfixe', () => {
  const hits = search(indexPath, { q: 'proxy', session: 'ses_fix', limit: 10, plain: true })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every(h => h.session_id.startsWith('ses_fix')))
})

test('filtres --after/--before', () => {
  const all = search(indexPath, { q: 'proxy palette setup', limit: 50, plain: true })
  const recent = search(indexPath, { q: 'proxy palette setup', limit: 50, plain: true, after: parseDateBound('2026-06-11') })
  assert.ok(all.length > recent.length)
  assert.ok(recent.every(h => h.ts >= parseDateBound('2026-06-11')))
  const old = search(indexPath, { q: 'proxy', limit: 50, plain: true, before: parseDateBound('2026-06-11', true) })
  assert.ok(old.length >= 1)
  assert.ok(old.every(h => h.ts <= parseDateBound('2026-06-11', true)))
})

test('filtre --model sous-chaîne', () => {
  const hits = search(indexPath, { q: 'palette', model: 'luna', limit: 10, plain: true })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every(h => (h.model || '').includes('luna')))
})

test('filtre --role', () => {
  const hits = search(indexPath, { q: 'proxy', role: 'user', limit: 10, plain: true })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every(h => h.role === 'user'))
})

test('sorties d\'outils brutes non indexées (spec : pas de bruit BM25)', () => {
  // « ok » n'existe que dans les sorties brutes (revert ok / go build ok), pas dans le texte indexé
  const hits = search(indexPath, { q: 'ok', limit: 10, plain: true })
  assert.equal(hits.length, 0)
})

test('requête sans termes exploitables → erreur', () => {
  assert.throws(() => search(indexPath, { q: '!!!', limit: 10 }), /vide/)
})
