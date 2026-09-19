// Change add-remedy-truncation (analyse du 19/09) : jamais de coupure silencieuse.
// Un message tronqué à l'affichage porte un marqueur (compteurs exacts + chemin qui
// existe vers l'intégral) ; --full lève la limite ; --chars N la fixe ; --json rend
// le texte intégral dans le champ text.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { sessionSlice, eventsBySession } from '../src/read.js'
import { renderRead, renderTerminal, renderJson } from '../src/format.js'
import { loadCorpus } from '../src/corpus.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-trunc-'))
const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const indexPath = path.join(root, 'index.db')

// Message long : 6 lignes, ~700 caractères, terme distinctif « prolixite ».
const LONG = [
  'prolixite constatee :',
  'ligne deux du long message',
  'ligne trois ' + 'x'.repeat(220),
  'ligne quatre ' + 'y'.repeat(220),
  'ligne cinq',
  'ligne six fin du long message'
].join('\n')
const LONGLEN = LONG.length
const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

before(async () => {
  buildFixtureDb(dbPath)
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const t = Date.now()
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run('msg_long1', 'ses_fix1', t, t, JSON.stringify({ role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm' }))
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run('prt_long1', 'msg_long1', 'ses_fix1', t, t, JSON.stringify({ type: 'text', text: LONG }))
  // régression 20/09 : message court, extrait décoré plus long que le message (coupure masquée)
  const BUG_TEXT = 'surbrillance un surbrillance deux surbrillance trois surbrillance quatre surbrillance cinq surbrillance six surbrillance sept fin'
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run('msg_bug1', 'ses_fix1', t + 1000, t + 1000, JSON.stringify({ role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm' }))
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run('prt_bug1', 'msg_bug1', 'ses_fix1', t + 1000, t + 1000, JSON.stringify({ type: 'text', text: BUG_TEXT }))
  db.close()
  await ingest({ root, db: dbPath })
  index(root, indexPath)
})
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

test('read : message long → marqueur avec compteurs exacts et chemin intégral', () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_long1', ctx: 0 })
  const out = renderRead(slice, 'ses_fix1', { plain: true })
  assert.ok(out.includes('⚠ message tronqué'), 'marqueur présent')
  assert.ok(out.includes(`(400/${fmt(LONGLEN)} caractères)`), `compteurs exacts 400/${fmt(LONGLEN)}`)
  assert.ok(out.includes('sdig read ses_fix1 --around msg_long1 --full'), 'chemin intégral')
  assert.ok(out.includes('sdig search --json'), 'chemin --json')
})

test('read --full : texte intégral, aucun marqueur', () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_long1', ctx: 0 })
  const out = renderRead(slice, 'ses_fix1', { full: true, plain: true })
  assert.ok(!out.includes('⚠'), 'aucun marqueur')
  assert.ok(out.includes('ligne six fin du long message'), 'fin du texte affichée')
})

test('read --chars N : borne explicite appliquée + marqueur', () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_long1', ctx: 0 })
  const out = renderRead(slice, 'ses_fix1', { chars: 60, plain: true })
  assert.ok(out.includes(`(60/${fmt(LONGLEN)} caractères)`), 'compteurs 60/total')
  // pas plus de 60 caractères de texte affichés pour ce message
  const shown = out.split('\n').filter(l => l.startsWith('    ') && !l.includes('⚠')).map(l => l.slice(4)).join('\n')
  assert.ok(shown.length <= 60, `borne respectée (${shown.length} ≤ 60)`)
})

test('read : message court → aucun marqueur', () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_u1', ctx: 0 })
  const out = renderRead(slice, 'ses_fix1', { plain: true })
  assert.ok(!out.includes('⚠'), 'aucun marqueur pour un message court')
})

test('recherche (hits groupés) : extrait < message → marqueur', () => {
  const hits = search(indexPath, { q: 'prolixite', limit: 3, plain: true })
  assert.equal(hits[0].id, 'msg_long1')
  const { events, sessionsById } = loadCorpus(root)
  const out = renderTerminal(hits, sessionsById, { plain: true })
  assert.ok(out.includes('⚠ message tronqué'), 'marqueur sur le hit')
  assert.ok(out.includes(`/${fmt(LONGLEN)} caractères)`), 'total exact')
  assert.ok(out.includes('sdig read ses_fix1 --around msg_long1 --full'), 'chemin intégral')
})

test('recherche --full : texte intégral du hit, aucun marqueur', () => {
  const hits = search(indexPath, { q: 'prolixite', limit: 3, plain: true })
  const { sessionsById } = loadCorpus(root)
  const out = renderTerminal(hits, sessionsById, { plain: true, full: true })
  assert.ok(!out.includes('⚠'), 'aucun marqueur')
  assert.ok(out.includes('ligne six fin du long message'), 'texte intégral')
})

test('recherche --ctx : voisin long → marqueur (fenêtre de contexte)', () => {
  const hits = search(indexPath, { q: 'renvoie 461', limit: 5, plain: true })
  assert.ok(hits.length >= 1)
  const { events, sessionsById } = loadCorpus(root)
  const evs = eventsBySession(events)
  const out = renderTerminal(hits, sessionsById, { ctx: 5, eventsBySession: evs, plain: true })
  assert.ok(out.includes('⚠ message tronqué'), 'marqueur sur le voisin long')
})

test('search --json : champ text = texte intégral (sans troncation)', () => {
  const hits = search(indexPath, { q: 'prolixite', limit: 3, plain: true })
  assert.equal(hits[0].text, LONG, 'le hit porte le texte intégral')
  const json = JSON.parse(renderJson(hits))
  assert.equal(json[0].text, LONG, 'rendu JSON intégral')
  assert.equal(json[0].id, 'msg_long1')
})

test('régression 20/09 : extrait décoré »…« plus long que le message → coupure détectée quand même', () => {
  // Retour utilisateur : en --plain, les marqueurs de surbrillance gonflent la longueur
  // de l'extrait ; la détection de coupure ne doit jamais mesurer le texte décoré.
  const hits = search(indexPath, { q: 'surbrillance', limit: 3, plain: true })
  const h = hits.find(x => x.id === 'msg_bug1')
  assert.ok(h, 'hit trouvé')
  const decorated = h.snip.split('\n').slice(0, 3).join('\n')
  assert.ok(decorated.length >= h.text.length, `régime du bug reproduit (décoré ${decorated.length} ≥ message ${h.text.length})`)
  assert.ok(!decorated.includes('fin'), 'la fin du message manque dans l\'extrait')
  assert.ok(h.snipPlain != null && !h.snipPlain.includes('»'), 'snipPlain : jumeau sans décorations')
  const { sessionsById } = loadCorpus(root)
  const out = renderTerminal([h], sessionsById, { plain: true })
  assert.ok(out.includes('⚠ message tronqué'), 'marqueur présent malgré la décoration')
  assert.ok(out.includes(`/${fmt(h.text.length)} caractères)`), 'compteur total exact')
  assert.ok(out.includes('sdig read ses_fix1 --around msg_bug1 --full'), 'chemin intégral')
})
