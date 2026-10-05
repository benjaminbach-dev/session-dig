// Tri CHRONOLOGIQUE de la recherche MCP (change add-mcp-chrono). Fixtures 100 %
// synthétiques (opencode-like + pi sous tmp, jamais ~/.pi). Couvre : sélection
// GLOBALE avant `limit`, ordre `(ts, id BINARY)`, `ts = 0`, filtres avant tri,
// exploration sans mots-clés (sous-ensemble canonique user/assistant, titre exclu,
// texte vide/commande seule inclus, `model: null`, `score: null`), score numérique
// en chrono avec requête, source inconnue/archivée absente, `total` exact/null,
// enveloppe 524 288, refus croisés `query`/`sort`, et validation CÔTÉ PROTOCOLE.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index } from '../src/retriever/bm25.js'
import {
  createSearchHandler,
  validateSearchInput,
  searchOutputSchema,
  appErrorPayload,
  RESPONSE_BUDGET_BYTES,
  measureSerialized,
  createMcpTestServer
} from '../src/mcp/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-chrono-'))
const prevPiDir = process.env.SESSION_DIG_PI_DIR

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi')
const piAbsent = path.join(tmp, 'pi-absente')
const PI_SES = fakeUuid()
const PI_EVENT = `pi:${PI_SES}:aa`

// Session sans vue (vue absente) : racine vide.
const emptyRoot = path.join(tmp, 'racine-vide')

const ZEBRE_MANY = 20

function addMsg (db, { sesId, msgId, ts, role = 'user', text = null, model = null, title = sesId, tool = null }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run(sesId, 'p', `/root/${sesId}`, title, ts, ts)
  const data = { role }
  if (model) data.model = model
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(msgId, sesId, ts, ts, JSON.stringify(data))
  if (text != null) db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
  if (tool) db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_tool_${msgId}`, msgId, sesId, ts + 1, ts + 1, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: tool }, metadata: { exitCode: 0 } } }))
}

before(async () => {
  fs.mkdirSync(emptyRoot, { recursive: true })
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    // Base vidée après création du schéma : l'ordre n'est biaisé par aucune donnée.
    db.exec('DELETE FROM part; DELETE FROM message; DELETE FROM session;')

    // Session chrono : `m_zero` (ts=0) est le plus ancien mais VOLONTAIREMENT peu
    // pertinent ; les 20 `m_newNN` sont très pertinents pour BM25 (hors top-k).
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_zero', ts: 0, role: 'assistant', model: { providerID: 'p', modelID: 'M' }, text: 'zebre alpha' })
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_old', ts: 1000, role: 'user', text: 'zebre' })
    for (let i = 0; i < ZEBRE_MANY; i++) {
      addMsg(db, { sesId: 'ses_chrono', msgId: `m_new${String(i).padStart(2, '0')}`, ts: 2000 + i, role: 'user', text: Array(20).fill('zebre').join(' ') })
    }
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_nomodel', ts: 5000, role: 'assistant', text: 'sans modele ici' })
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_model', ts: 6000, role: 'assistant', model: { providerID: 'prov', modelID: 'M' }, text: 'avec modele M' })
    // Texte VIDE (chaîne vide) et commande SEULE (texte NULL).
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_empty', ts: 7000, role: 'user', text: '' })
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_cmd', ts: 7100, role: 'assistant', tool: 'commandeoutil unique' })
    // Texte long : l'extrait d'exploration est un SUBSTR borné, coupure signalée.
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_long', ts: 7200, role: 'assistant', text: 'explorationlongue ' + 'x'.repeat(30000) })

    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_cmd_long', ts: 7300, role: 'assistant', tool: '🙂'.repeat(20001) })

    // Sélection exhaustive mais extraits trop volumineux pour l'enveloppe.
    for (let i = 0; i < 30; i++) {
      addMsg(db, { sesId: 'ses_budget', msgId: `m_budget_${String(i).padStart(2, '0')}`, ts: 9000 + i, text: 'budgetchrono ' + 'x'.repeat(30000) + '🙂'.repeat(30000) })
    }

    // Titre contenant un mot-clé (éligible AVEC `query`, exclu SANS).
    addMsg(db, { sesId: 'ses_titles', msgId: 'm_title', ts: 8000, role: 'user', text: 'autre chose', title: 'titrechrono motcle' })

    // Deux sessions entrelacées : l'ordre chrono global doit entrelacer les sessions.
    addMsg(db, { sesId: 'ses_x', msgId: 'm_x1', ts: 2500, role: 'user', text: 'contexte X' })
    addMsg(db, { sesId: 'ses_y', msgId: 'm_y1', ts: 2600, role: 'user', text: 'contexte Y' })

    // Source `omega` : événement opencode et événement pi au MÊME ts (départage BINARY).
    // Titre SANS « omega » pour ne pas ajouter de hit de titre parasite.
    addMsg(db, { sesId: 'ses_omega', msgId: 'm_omega', ts: T0 + 300000, role: 'user', text: 'omega partage', title: 'Partage OC' })
  } finally { db.close() }

  writePiSession(piDir, 'proj', 'ses_pi.jsonl', [
    sessionLine(PI_SES, T0 + 300000, '/root/pirepo'),
    infoLine(T0 + 10, 'Partage Pi', 'inf'),
    messageLine(T0 + 300000, { role: 'user', timestamp: T0 + 300000, content: [{ type: 'text', text: 'omega partage' }] }, 'aa')
  ])

  process.env.SESSION_DIG_PI_DIR = piDir
  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root)
})

after(() => {
  if (prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = prevPiDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

const cfg = (sources, r = root) => ({ root: r, sources })
const withPi = cfg({ opencode: { path: dbPath }, pi: { path: piDir } })
const piGone = cfg({ opencode: { path: dbPath }, pi: { path: piAbsent } })

function call (handler, raw) {
  const v = validateSearchInput(raw)
  return handler(v.value, v.adaptations)
}

function expectAppError (fn, code) {
  try {
    fn()
    assert.fail('devait refuser')
  } catch (e) {
    const payload = appErrorPayload(e)
    assert.equal(payload.code, code)
    assert.ok(!JSON.stringify(payload).includes(tmp), 'aucun chemin local dans l’erreur')
    return payload
  }
}

function envelopeBytes (out) {
  return measureSerialized({ jsonrpc: '2.0', id: 'x'.repeat(128), result: { content: [], structuredContent: out } })
}

// ── Sélection globale avant `limit`, ordre (ts, id) ─────────────────────────

test('oldest : le plus ancien match HORS top-k BM25 sort en tête (sélection globale)', () => {
  const handler = createSearchHandler(withPi)
  const rel = call(handler, { query: 'zebre', limit: 5 })
  assert.ok(!rel.hits.some((h) => h.ref.messageId === 'm_zero'), 'relevance top-5 exclut le plus ancien (peu pertinent)')

  const chrono = call(handler, { query: 'zebre', sort: 'oldest', limit: 5 })
  assert.ok(searchOutputSchema.safeParse(chrono).success)
  assert.equal(chrono.hits[0].ref.messageId, 'm_zero')
  assert.equal(chrono.hits[0].ts, 0, 'ts = 0 est une valeur valide, pas une absence')
  assert.ok(chrono.hits.every((h) => typeof h.score === 'number'), 'score BM25 diagnostique en chrono AVEC requête')
  for (let i = 1; i < chrono.hits.length; i++) {
    const a = chrono.hits[i - 1]; const b = chrono.hits[i]
    assert.ok(a.ts < b.ts || (a.ts === b.ts && a.ref.messageId <= b.ref.messageId), 'ordre (ts, id) croissant')
  }

  const newest = call(handler, { query: 'zebre', sort: 'newest', limit: 5 })
  assert.ok(newest.hits[0].ts >= newest.hits[newest.hits.length - 1].ts)
  assert.notEqual(newest.hits[0].ref.messageId, 'm_zero', 'newest ne rend pas le plus ancien en tête')
})

test('ts égaux multi-source : départage par id canonique BINARY (oldest et newest)', () => {
  const handler = createSearchHandler(withPi)
  const asc = call(handler, { query: 'omega', sort: 'oldest', limit: 10 })
  assert.deepEqual(asc.hits.map((h) => h.ref.messageId), ['m_omega', PI_EVENT])
  const desc = call(handler, { query: 'omega', sort: 'newest', limit: 10 })
  assert.deepEqual(desc.hits.map((h) => h.ref.messageId), [PI_EVENT, 'm_omega'])
})

test('filtres appliqués AVANT tri et limite', () => {
  const handler = createSearchHandler(withPi)
  const user = call(handler, { query: 'zebre', sort: 'oldest', role: 'user', limit: 1 })
  assert.equal(user.hits.length, 1)
  assert.equal(user.hits[0].ref.messageId, 'm_old', 'le filtre role user écarte m_zero (assistant)')
  const bounded = call(handler, { query: 'zebre', sort: 'oldest', after: 2000, limit: 1 })
  assert.ok(bounded.hits[0].ts >= 2000, 'borne after appliquée avant tri')
})

test('titre éligible AVEC query en chrono (compatibilité relevance)', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { query: 'titrechrono', sort: 'oldest', limit: 5 })
  assert.equal(out.hits.length, 1)
  assert.equal(out.hits[0].kind, 'title')
  assert.equal(out.hits[0].ref.messageId, null, 'un titre référence la seule session')
})

// ── Exploration sans mots-clés (browseChrono) ───────────────────────────────

test('exploration : sous-ensemble canonique, titre exclu, ts=0, score null, model null explicite', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { sort: 'oldest', limit: 50 })
  assert.ok(searchOutputSchema.safeParse(out).success)
  assert.equal(out.hits[0].ref.messageId, 'm_zero')
  assert.equal(out.hits[0].ts, 0)
  assert.ok(out.hits.every((h) => h.role === 'user' || h.role === 'assistant'), 'aucune ligne de titre en exploration')
  assert.ok(out.hits.every((h) => h.kind === 'message'))
  assert.ok(out.hits.every((h) => h.score === null), 'score: null en exploration (BM25 non calculé)')
  const sansModel = out.hits.find((h) => h.ref.messageId === 'm_nomodel')
  assert.equal(sansModel.model, null, 'modèle absent jamais inventé')
  // Les hits portent l'ordre chrono GLOBAL (sessions entrelacées) ; groups n'est qu'un index.
  for (let i = 1; i < out.hits.length; i++) {
    const a = out.hits[i - 1]; const b = out.hits[i]
    assert.ok(a.ts < b.ts || (a.ts === b.ts && a.ref.messageId <= b.ref.messageId))
  }
  assert.ok(out.groups.some((g) => g.sessionId === 'ses_x') && out.groups.some((g) => g.sessionId === 'ses_y'))
})

test('exploration : role title ou inconnu ⇒ zéro hit', () => {
  const handler = createSearchHandler(withPi)
  assert.equal(call(handler, { sort: 'oldest', role: 'title', limit: 50 }).hits.length, 0)
  assert.equal(call(handler, { sort: 'oldest', role: 'inconnu', limit: 50 }).hits.length, 0)
})

test('exploration : texte vide et commande seule INCLUS (pas un mode FTS)', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { sort: 'oldest', limit: 50 })
  const empty = out.hits.find((h) => h.ref.messageId === 'm_empty')
  const cmd = out.hits.find((h) => h.ref.messageId === 'm_cmd')
  assert.ok(empty, 'événement à texte vide inclus')
  assert.ok(cmd, 'événement à commande seule inclus')
  assert.equal(cmd.excerptKind, 'cmd', 'extrait d’exploration produit depuis cmd')
  assert.ok(cmd.excerpt.text.includes('commandeoutil'), 'substr borné sur cmd, pas un extrait vide')
})

test('exploration : extrait SUBSTR borné, coupure signalée exactement (texte long vs court)', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { sort: 'oldest', limit: 50 })
  const long = out.hits.find((h) => h.ref.messageId === 'm_long')
  const short = out.hits.find((h) => h.ref.messageId === 'm_old')
  assert.ok([...long.excerpt.text].length <= 20000, 'extrait borné à 20 000 points de code')
  assert.equal(long.excerpt.truncated, true, 'texte long ⇒ coupure signalée (snipFull=0)')
  assert.equal(short.excerpt.truncated, false, 'texte court ⇒ extrait intégral signalé (snipFull=1)')
  assert.ok(!/\x1b\[[0-9;]*m/.test(long.excerpt.text), 'aucun ANSI dans l’extrait d’exploration')
})

test('exploration : plus ancien assistant portant le modèle M ({ sort, role, model, limit: 1 })', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { sort: 'oldest', role: 'assistant', model: 'M', limit: 1 })
  assert.equal(out.hits.length, 1)
  assert.equal(out.hits[0].ref.messageId, 'm_zero')
  assert.equal(out.hits[0].ts, 0)
  assert.ok(out.hits[0].model.includes('M'))
  assert.equal(out.hits[0].score, null)
})

test('exploration : source inconnue ⇒ zéro hit ; source pi archivée absente du disque reste cherchable', () => {
  const absent = createSearchHandler(piGone)
  const unknown = call(absent, { sort: 'oldest', source: 'martien', limit: 50 })
  assert.equal(unknown.hits.length, 0)
  const archived = call(absent, { sort: 'oldest', source: 'pi', limit: 50 })
  assert.ok(archived.hits.length >= 1, 'provenance archivée cherchable sans lecture de la source disparue')
  assert.ok(archived.hits.every((h) => h.source === 'pi'))
  assert.ok(archived.hits.every((h) => h.fidelity && h.fidelity.source === 'pi'), 'fidélité pi conservée')
})

// ── total, enveloppe, non-régression relevance ──────────────────────────────

test('total exact quand la sélection n’atteint pas `limit`, null quand elle est bornée', () => {
  const handler = createSearchHandler(withPi)
  const all = call(handler, { sort: 'oldest', session: 'ses_chrono', limit: 50 })
  assert.equal(all.count, all.total, 'sélection exhaustive (< limit) ⇒ total exact')
  const bounded = call(handler, { sort: 'oldest', limit: 2 })
  assert.equal(bounded.count, 2)
  assert.equal(bounded.total, null, 'sélection bornée ⇒ total inconnu, jamais estimé')
})

test('chrono avec ctx : voisins bornés référencés sans curseur, enveloppe tenue', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { query: 'zebre', sort: 'oldest', limit: 10, ctx: 2 })
  assert.ok(searchOutputSchema.safeParse(out).success)
  assert.ok(envelopeBytes(out) <= RESPONSE_BUDGET_BYTES)
  assert.ok(!Object.hasOwn(out, 'nextCursor'))
  for (const n of out.neighbors) {
    assert.ok(n.ref.sessionId && n.ref.messageId, 'voisin référencé vers sdig_read')
    assert.ok(n.forRef.sessionId)
  }
})

test('non-régression : relevance (défaut) et sort absent restent inchangés', () => {
  const handler = createSearchHandler(withPi)
  const a = call(handler, { query: 'zebre', limit: 5 })
  const b = call(handler, { query: 'zebre', sort: 'relevance', limit: 5 })
  assert.deepEqual(a.hits.map((h) => h.ref.messageId), b.hits.map((h) => h.ref.messageId))
  assert.ok(a.hits.every((h) => typeof h.score === 'number'))
  assert.ok(!a.hits.some((h) => h.ref.messageId === 'm_zero'), 'relevance ne remonte pas le plus ancien peu pertinent')
})

// ── Garde-fous et refus croisés (validation applicative) ────────────────────

test('sort inconnu, query manquante en relevance, query fournie vide/stopwords ⇒ invalid_params', () => {
  const handler = createSearchHandler(withPi)
  expectAppError(() => validateSearchInput({ query: 'zebre', sort: 'sideways' }), 'invalid_params')
  expectAppError(() => validateSearchInput({}), 'invalid_params')
  expectAppError(() => validateSearchInput({ sort: 'relevance' }), 'invalid_params')
  expectAppError(() => validateSearchInput({ sort: 'oldest', query: undefined }), 'invalid_params')
  expectAppError(() => validateSearchInput({ sort: 'oldest', query: null }), 'invalid_params')
  expectAppError(() => validateSearchInput({ sort: 'oldest', query: '' }), 'invalid_params')
  expectAppError(() => validateSearchInput({ sort: 'oldest', query: '   ' }), 'invalid_params')
  expectAppError(() => call(handler, { sort: 'oldest', query: 'comment la the of' }), 'invalid_params')
  expectAppError(() => validateSearchInput({ query: 'zebre', cursor: 'x' }), 'invalid_params')
  // `sort` inconnu ramené silencieusement ? Non : seuls relevance/oldest/newest passent.
  assert.equal(validateSearchInput({ query: 'zebre', sort: 'oldest' }).value.sort, 'oldest')
})

test('vue absente : view_unavailable en chrono comme en exploration', () => {
  const handler = createSearchHandler(cfg({ opencode: { path: dbPath }, pi: { path: piAbsent } }, emptyRoot))
  expectAppError(() => call(handler, { query: 'zebre', sort: 'oldest' }), 'view_unavailable')
  expectAppError(() => call(handler, { sort: 'oldest' }), 'view_unavailable')
})

test('exploration newest : ordre global inversé et bornes/filtres avant limite', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { sort: 'newest', session: 'ses_chrono', after: 1000, before: 7000, role: 'assistant', model: 'M', limit: 1 })
  assert.equal(out.hits[0].ref.messageId, 'm_model')
  assert.equal(out.hits[0].score, null)
})

test('commandes longues Unicode : extraits SQL bornés, longueur réelle et référence read', () => {
  const handler = createSearchHandler(withPi)
  const out = call(handler, { sort: 'oldest', session: 'ses_chrono', after: 7300, before: 7300 })
  assert.equal(out.hits.length, 1)
  const hit = out.hits[0]
  assert.equal(hit.ref.messageId, 'm_cmd_long')
  assert.equal(hit.excerptKind, 'cmd')
  assert.equal([...hit.excerpt.text].length, 20000)
  assert.equal(hit.excerpt.truncated, true)
  assert.deepEqual(out.truncated.dimensions.find(d => d.dimension === 'excerpt_chars'), { dimension: 'excerpt_chars', retained: 20000, total: 20001 })
})

test('budget chrono avec/sans query : réduction signalée et total de sélection conservé', () => {
  const handler = createSearchHandler(withPi)
  for (const query of [undefined, 'budgetchrono']) {
    const args = { sort: 'oldest', session: 'ses_budget', role: 'user', limit: 50 }
    if (query !== undefined) args.query = query
    const out = call(handler, args)
    assert.equal(out.total, 30, 'total exact indépendant de la réduction d’enveloppe')
    assert.equal(out.topK, 50)
    assert.ok(envelopeBytes(out) <= RESPONSE_BUDGET_BYTES)
    assert.ok(out.adaptations.some(a => a.field === 'excerpt_chars' && a.reason === 'budget'))
    assert.ok(out.truncated.dimensions.some(d => d.dimension === 'excerpt_chars'))
    assert.ok(searchOutputSchema.safeParse(out).success)
  }
})

test('vue périmée : refus borné sans réparation dans les deux modes chrono', () => {
  const staleRoot = path.join(tmp, 'corpus-perime')
  fs.cpSync(root, staleRoot, { recursive: true })
  const statePath = path.join(staleRoot, 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.sources.opencode.message += 1000
  fs.writeFileSync(statePath, JSON.stringify(state))
  const before = fs.readFileSync(path.join(staleRoot, 'index.db'))
  const handler = createSearchHandler(cfg(withPi.sources, staleRoot))
  for (const args of [{ sort: 'oldest', query: 'zebre' }, { sort: 'newest' }]) {
    const error = expectAppError(() => call(handler, args), 'view_unavailable')
    assert.equal(error.reason, 'stale_view')
  }
  assert.deepEqual(fs.readFileSync(path.join(staleRoot, 'index.db')), before)
})

// ── Validation CÔTÉ PROTOCOLE (client MCP officiel) ─────────────────────────

test('client MCP réel : exploration, sort inconnu et requête manquante refusés au protocole', async () => {
  const handlers = {
    sdig_search: createSearchHandler(withPi),
    sdig_read: async () => ({}),
    sdig_status: async () => ({ counts: { sessions: 0, events: 0 }, rawFiles: null, rawReferences: 0, view: null, viewNote: null, sources: {}, freshness: { sources: {}, indexMtime: null, corpusVersion: null } })
  }
  const srv = createMcpTestServer({ handlers })
  await srv.start()
  try {
    const client = new Client({ name: 'mcp-chrono-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`))
    await client.connect(transport)
    try {
      const explore = await client.callTool({ name: 'sdig_search', arguments: { sort: 'oldest', limit: 1 } })
      assert.notEqual(explore.isError, true)
      assert.ok(searchOutputSchema.safeParse(explore.structuredContent).success)
      assert.equal(explore.structuredContent.hits[0].ref.messageId, 'm_zero')
      assert.equal(explore.structuredContent.hits[0].score, null)

      for (const args of [{ sort: 'sideways', query: 'zebre' }, { sort: 'relevance' }, {}, { query: 'zebre', cursor: 'x' }]) {
        const bad = await client.callTool({ name: 'sdig_search', arguments: args })
        assert.equal(bad.isError, true, `refus attendu pour ${JSON.stringify(args)}`)
        assert.equal(JSON.parse(bad.content[0].text).code, 'invalid_params')
      }
    } finally {
      await client.close()
    }
  } finally {
    await srv.close()
  }
})
