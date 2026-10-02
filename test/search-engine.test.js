// Moteur de recherche partagé (sous-lot search A) : départage des rangs égaux en
// ordre binaire AVANT la limite, filtre `session` en préfixe LITTÉRAL (métacaractères
// échappés), erreur d'entrée typée pour une façade MCP (`invalid_params`), et option
// additive `boundedText` qui évite de charger les textes complets. Fixtures 100 %
// synthétiques, source pi sous le tmp du test (jamais ~/.pi).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import {
  index,
  search,
  SearchQueryError,
  isSearchQueryError,
  SEARCH_ERROR_NO_TERMS,
  MAX_BOUNDED_EXCERPT_CHARS
} from '../src/retriever/bm25.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-search-engine-'))
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const indexPath = path.join(root, 'index.db')
const piDir = path.join(tmp, 'pi-egal')
const EQUAL_TEXT = 'zzz egal multi source motif'
const PI_EQUAL_COUNT = 60
const OC_EQUAL_COUNT = 10
// Token UNIQUE de 60 000 caractères accentués : la borne `tokens` de `snippet()`
// ne le couperait pas ; la borne SQL de `boundedText` doit s'appliquer.
const HUGE_TOKEN = 'é'.repeat(60000)

/** Ajoute un message opencode synthétique (session + message + part texte). */
function addOpencodeMessage (db, { sesId, msgId, text, ts, title = null }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sesId, 'p', `/root/${sesId.replace(/[^a-z0-9]/gi, '')}`, title ?? sesId, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, sesId, ts, ts, JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'eq', modelID: 'eq' } }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
}

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    // Rangs ÉGAUX multi-sources : OC_EQUAL_COUNT messages opencode au texte identique.
    for (let i = 0; i < OC_EQUAL_COUNT; i++) {
      addOpencodeMessage(db, { sesId: 'ses_eq', msgId: `msg_eq_${String(i).padStart(2, '0')}`, text: EQUAL_TEXT, ts: T0 + 100000 + i, title: 'Égal multi-source' })
    }
    // Préfixe LITTÉRAL : identifiants contenant `%`, `_`, `\`.
    addOpencodeMessage(db, { sesId: 'ses_pct%x', msgId: 'msg_pctpct', text: 'metaprefix alpha', ts: T0 + 200000 })
    addOpencodeMessage(db, { sesId: 'ses_pct0x', msgId: 'msg_pct0', text: 'metaprefix beta', ts: T0 + 200001 })
    addOpencodeMessage(db, { sesId: 'ses_us_x', msgId: 'msg_usx', text: 'metaprefix gamma', ts: T0 + 200002 })
    addOpencodeMessage(db, { sesId: 'ses_usYx', msgId: 'msg_usY', text: 'metaprefix delta', ts: T0 + 200003 })
    addOpencodeMessage(db, { sesId: 'ses_bs\\z', msgId: 'msg_bsz', text: 'metaprefix epsilon', ts: T0 + 200004 })
    // Énorme token unique (accents) entouré d'emoji/bornes, et cas de coupe dense
    // en emoji astraux (frontières de points de code).
    addOpencodeMessage(db, { sesId: 'ses_huge', msgId: 'msg_huge', text: `avant 🙂 ${HUGE_TOKEN} 🙂 après`, ts: T0 + 300000, title: 'Géant accents' })
    addOpencodeMessage(db, { sesId: 'ses_bound', msgId: 'msg_bound', text: 'starttoken ' + '🙂'.repeat(30000) + ' endtoken', ts: T0 + 300001, title: 'Bornes emoji' })
  } finally { db.close() }

  // PI_EQUAL_COUNT messages pi au MÊME texte → rangs égaux avec les messages opencode.
  const uuid = fakeUuid()
  const lines = [sessionLine(uuid, T0, '/root/pi-egal'), infoLine(T0 + 10, 'Égal pi', 'infe')]
  for (let i = 0; i < PI_EQUAL_COUNT; i++) {
    lines.push(messageLine(T0 + 1000 + i, { role: 'user', content: [{ type: 'text', text: EQUAL_TEXT }], timestamp: T0 + 1000 + i }))
  }
  writePiSession(piDir, 'proj-eq', 'ses_eq.jsonl', lines)

  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root, indexPath)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ── Départage binaire des rangs égaux avant la limite ───────────────────────

test('rangs égaux multi-sources : ordre binaire stable, limite après sélection', () => {
  const total = PI_EQUAL_COUNT + OC_EQUAL_COUNT
  const hits = search(indexPath, { q: 'zzz', limit: total + 10, plain: true })
  assert.equal(hits.length, total)
  assert.deepEqual([...new Set(hits.map(h => h.source))].sort(), ['opencode', 'pi'], 'les deux sources sont représentées')
  assert.equal(new Set(hits.map(h => h.score)).size, 1, 'rangs strictement égaux (textes identiques)')

  const ids = hits.map(h => h.id)
  assert.deepEqual(ids, [...ids].sort(), 'identifiants en ordre binaire quand le rang est égal')

  // La sélection précède la limite : une limite plus petite rend le MÊME préfixe stable.
  const limited = search(indexPath, { q: 'zzz', limit: 50, plain: true })
  assert.equal(limited.length, 50)
  assert.deepEqual(limited.map(h => h.id), ids.slice(0, 50))

  // Rejeu : ordre identique (déterminisme des données).
  const replay = search(indexPath, { q: 'zzz', limit: total + 10, plain: true })
  assert.deepEqual(replay.map(h => h.id), ids)
})

// ── Filtre session : préfixe LITTÉRAL ───────────────────────────────────────

test('session : préfixe littéral, `%` n’est pas un joker', () => {
  const all = search(indexPath, { q: 'metaprefix', limit: 20, plain: true })
  assert.equal(all.length, 5)

  const pct = search(indexPath, { q: 'metaprefix', session: 'ses_pct%x', limit: 20, plain: true })
  assert.equal(pct.length, 1)
  assert.equal(pct[0].session_id, 'ses_pct%x')

  // `ses_%` serait un joker « tous les ses_… » sans échappement : littéral = zéro.
  assert.equal(search(indexPath, { q: 'metaprefix', session: 'ses_%', limit: 20, plain: true }).length, 0)
  assert.equal(search(indexPath, { q: 'metaprefix', session: 'ses_pct', limit: 20, plain: true }).length, 2)
})

test('session : `_` littéral n’est pas un joker simple-caractère', () => {
  const us = search(indexPath, { q: 'metaprefix', session: 'ses_us_x', limit: 20, plain: true })
  assert.equal(us.length, 1)
  assert.equal(us[0].session_id, 'ses_us_x')
  assert.equal(search(indexPath, { q: 'metaprefix', session: 'ses_us', limit: 20, plain: true }).length, 2)
})

test('session : backslash littéral conservé (ESCAPE déclaré)', () => {
  const bs = search(indexPath, { q: 'metaprefix', session: 'ses_bs\\', limit: 20, plain: true })
  assert.equal(bs.length, 1)
  assert.equal(bs[0].session_id, 'ses_bs\\z')
})

// ── Erreur d'entrée typée (façade future : invalid_params) ──────────────────

test('stopwords seuls : SearchQueryError typée `no_terms`, pas une erreur interne', () => {
  for (const q of ['comment la the of', '!!!', '   ']) {
    try {
      search(indexPath, { q, limit: 5 })
      assert.fail(`devait refuser : ${JSON.stringify(q)}`)
    } catch (e) {
      assert.ok(isSearchQueryError(e), 'instance SearchQueryError')
      assert.equal(e.name, 'SearchQueryError')
      assert.equal(e.code, SEARCH_ERROR_NO_TERMS)
      assert.match(e.message, /vide/)
    }
  }
  assert.equal(isSearchQueryError(new Error('x')), false)
  assert.equal(new SearchQueryError().code, 'no_terms')
})

// ── Option additive boundedText ─────────────────────────────────────────────

test('boundedText : extraits sans charger text/cmd complets, identiques au défaut', () => {
  const full = search(indexPath, { q: 'proxy', limit: 5, plain: true })
  assert.ok(full.length >= 1)
  const bounded = search(indexPath, { q: 'proxy', limit: 5, plain: true, boundedText: true })
  assert.ok(bounded.length >= 1)

  // Même sélection, même ordre, mêmes extraits : le mode borné ne change PAS le classement.
  assert.deepEqual(bounded.map(h => h.id), full.map(h => h.id))
  assert.deepEqual(bounded.map(h => h.snip), full.map(h => h.snip))
  assert.deepEqual(bounded.map(h => h.snipPlain), full.map(h => h.snipPlain))
  assert.deepEqual(bounded.map(h => h.snipCmd), full.map(h => h.snipCmd))

  for (const h of full) {
    assert.ok(Object.hasOwn(h, 'text'), 'défaut : texte complet présent')
    assert.ok(Object.hasOwn(h, 'cmd'), 'défaut : cmd complet présent')
  }
  for (const h of bounded) {
    assert.ok(!Object.hasOwn(h, 'text'), 'borné : pas de texte complet chargé')
    assert.ok(!Object.hasOwn(h, 'cmd'), 'borné : pas de cmd complet chargé')
    assert.ok(Object.hasOwn(h, 'textLen'), 'borné : longueur de texte fournie')
    assert.ok(Object.hasOwn(h, 'cmdLen'), 'borné : longueur de cmd fournie')
  }

  // Longueurs en points de code (aligné sur l'unité de fragmentation read).
  const fullHit = full.find(h => h.id === 'msg_u1')
  const boundedHit = bounded.find(h => h.id === 'msg_u1')
  assert.ok(fullHit && boundedHit)
  assert.equal(boundedHit.textLen, [...fullHit.text].length)
  assert.equal(boundedHit.snip, fullHit.snip)
})

// ── Borne SQL des extraits : token unique énorme et frontières de points de code ──

test('boundedText : token unique >60 000 (accents/emoji) borné dans SQL, coupure détectable', () => {
  const full = search(indexPath, { q: HUGE_TOKEN, limit: 5, plain: true })
  assert.equal(full.length, 1)
  assert.equal(full[0].id, 'msg_huge')
  // Défaut CLI : extrait NON borné (la sémantique par défaut ne change pas).
  assert.ok([...full[0].snipPlain].length > MAX_BOUNDED_EXCERPT_CHARS, 'défaut : extrait non borné')

  const bounded = search(indexPath, { q: HUGE_TOKEN, limit: 5, plain: true, boundedText: true })
  assert.equal(bounded.length, 1)
  const b = bounded[0]
  assert.equal([...b.snipPlain].length, MAX_BOUNDED_EXCERPT_CHARS, 'extrait borné exactement au plafond SQL')
  for (const k of ['snip', 'snipPlain', 'snipCmd']) {
    if (b[k] == null) continue
    assert.ok([...b[k]].length <= MAX_BOUNDED_EXCERPT_CHARS, `${k} borné en points de code`)
    assert.ok(b[k].isWellFormed(), `${k} bien formé (aucun demi-surrogate)`)
  }
  // Longueurs RÉELLES non bornées : la coupure est détectable exactement.
  assert.equal(b.snipPlainLen, [...full[0].snipPlain].length)
  assert.ok(b.snipPlainLen > MAX_BOUNDED_EXCERPT_CHARS, 'coupure détectable via snipPlainLen')
  assert.ok(b.textLen > 60000, 'longueur réelle du texte conservée')
  assert.ok(b.snipPlain.includes('🙂'), 'emoji conservés avant la coupe')
  assert.ok(!b.snipPlain.includes('\uFFFD'), 'aucun caractère de remplacement')
})

test('boundedText : coupe sur frontière de point de code (emoji astral dense)', () => {
  const bounded = search(indexPath, { q: 'starttoken', limit: 5, plain: true, boundedText: true })
  assert.equal(bounded.length, 1)
  const b = bounded[0]
  assert.equal([...b.snipPlain].length, MAX_BOUNDED_EXCERPT_CHARS)
  assert.ok(b.snipPlainLen > MAX_BOUNDED_EXCERPT_CHARS)
  assert.ok(b.snipPlain.isWellFormed(), 'coupe SQL en points de code : aucun demi-surrogate')
  assert.ok(b.snipPlain.includes('🙂'))
})
