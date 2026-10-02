// Contrats MCP lot M1a — catalogue fermé, schémas SDK, validation, confidentialité.
// Aucun serveur réseau : le test SDK utilise InMemoryTransport et des stubs de
// handler LOCAUX AU TEST (aucun handler métier livré). Fixtures synthétiques only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import {
  MCP_HOST,
  MCP_PORT,
  RESPONSE_BUDGET_BYTES,
  MAX_SEARCH_HITS,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_CTX,
  MAX_READ_CTX,
  MAX_READ_TAIL,
  MAX_READ_CHARS,
  MAX_QUERY_CHARS,
  READ_OFFSET_UNIT,
  READ_TEXT_ENCODING,
  TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_DESCRIPTIONS,
  searchInputSchema,
  readInputSchema,
  statusInputSchema,
  searchOutputSchema,
  searchTruncationSchema,
  readOutputSchema,
  statusOutputSchema,
  validateSearchInput,
  validateReadInput,
  validateStatusInput,
  utf8Bytes,
  measureSerialized,
  fitsBudget,
  McpAppError,
  APP_ERROR_MESSAGES,
  appErrorPayload,
  toToolErrorResult
} from '../src/mcp/index.js'
import { buildFixtureDb } from './helpers/fixture.js'
import { LAYOUT_VERSION } from '../src/layout.js'
import { ingest } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { sessionSlice } from '../src/read.js'
import { renderJson, renderReadJson, PI_FIDELITY_LIMITS, PI_FIDELITY_NOTE } from '../src/format.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-mcp-contracts-'))
const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi-vide')

before(async () => {
  buildFixtureDb(dbPath)
  fs.mkdirSync(piDir, { recursive: true })
  await ingest({ root, db: dbPath, piDir })
  index(root)
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const freshness = { sources: {}, indexMtime: null, corpusVersion: null }
const refMessage = { sessionId: 'ses_fix1', messageId: 'msg_u1' }
const refTitle = { sessionId: 'ses_pi', messageId: null }
const excerpt = { text: 'extrait', truncated: true }
const hit = {
  kind: 'message',
  ref: refMessage,
  ts: 1,
  date: '2026-06-10 10:00',
  role: 'user',
  source: 'opencode',
  agent: null,
  repo: 'r',
  model: null,
  score: 1.5,
  excerpt,
  cost: 0.1
}
const neighbor = {
  kind: 'message',
  ref: { sessionId: 'ses_fix1', messageId: 'msg_a1' },
  forRef: refMessage,
  ts: 2,
  role: 'assistant',
  source: 'opencode',
  excerpt: { text: 'voisin', truncated: false }
}
const group = { sessionId: 'ses_fix1', source: 'opencode', title: 't', repo: 'r', hitRefs: [refMessage], neighborRefs: [neighbor.ref] }
const searchEnvelope = {
  hits: [hit], neighbors: [neighbor], groups: [group],
  count: 1, topK: 10, total: null, adaptations: [], freshness
}
const readEnvelope = {
  sessionId: 'ses_fix1',
  title: 't',
  repo: 'r',
  anchor: null,
  maskedCount: 0,
  visible: 1,
  total: 1,
  messages: [{
    index: 0, id: 'msg_u1', ts: 1, date: '2026-06-10 10:00', role: 'user',
    agent: null, model: null, text: 'frag', offset: 0, end: 4, complete: true, toolCalls: []
  }],
  adaptations: [],
  freshness
}
const statusEnvelope = {
  counts: { sessions: 2, events: 7 },
  rawFiles: 0,
  rawReferences: 0,
  view: { events: 7, mtime: 1 },
  viewNote: null,
  sources: {
    opencode: { available: true, ingested: true, watermark: { message: 1, session: 1 }, counts: { sessions: 2, events: 7 } },
    pi: { available: false, ingested: false, watermark: null, counts: { sessions: null, events: null } }
  },
  freshness
}

// ── Catalogue fermé ─────────────────────────────────────────────────────────

test('catalogue fermé : exactement search/read/status, aucun raw', () => {
  assert.deepEqual([...TOOL_NAMES], ['sdig_search', 'sdig_read', 'sdig_status'])
  assert.deepEqual(TOOL_DEFINITIONS.map(d => d.name), [...TOOL_NAMES])
  assert.ok(!TOOL_NAMES.includes('sdig_raw'))
  assert.ok(TOOL_DEFINITIONS.every(d => d.annotations.readOnlyHint === true))
  assert.ok(TOOL_DEFINITIONS.every(d => d.annotations.openWorldHint === false))
})

test('constantes et budget conformes au design', () => {
  assert.equal(MCP_HOST, '127.0.0.1')
  assert.equal(MCP_PORT, 18767)
  assert.equal(RESPONSE_BUDGET_BYTES, 524288)
  assert.equal(MAX_SEARCH_HITS, 50)
  assert.equal(DEFAULT_SEARCH_LIMIT, 10)
  assert.equal(MAX_SEARCH_CTX, 5)
  assert.equal(MAX_READ_CTX, 50)
  assert.equal(MAX_READ_TAIL, 200)
  assert.equal(MAX_READ_CHARS, 20000)
})

test('unités read fixées au contrat (points de code, UTF-8) sans helper de fragmentation', () => {
  assert.equal(READ_OFFSET_UNIT, 'unicode-code-point')
  assert.equal(READ_TEXT_ENCODING, 'utf-8')
  assert.equal(MAX_READ_CHARS, 20000)
  assert.match(TOOL_DESCRIPTIONS.sdig_read, /POINTS DE CODE/)
  assert.match(TOOL_DESCRIPTIONS.sdig_read, /UTF-8/)
  assert.match(TOOL_DESCRIPTIONS.sdig_read, /`end` exclu/)
})

test('mesure d’enveloppe UTF-8 : accents et emoji comptés en octets', () => {
  assert.equal(utf8Bytes('abc'), 3)
  assert.equal(utf8Bytes('é'), 2)
  assert.equal(utf8Bytes('😀'), 4)
  assert.equal(fitsBudget({ a: 'x'.repeat(10) }), true)
  assert.equal(fitsBudget({ a: 'x'.repeat(RESPONSE_BUDGET_BYTES) }), false)
  assert.ok(measureSerialized({ a: 'é' }) >= 2)
})

// ── Descriptions (confidentialité, non-fiabilité, limites pi) ───────────────

test('les trois descriptions portent les avertissements obligatoires', () => {
  for (const name of TOOL_NAMES) {
    const d = TOOL_DESCRIPTIONS[name]
    assert.ok(d && d.length > 100, `${name} décrit`)
    assert.match(d, /secrets/)
    assert.match(d, /fournisseur du modèle/)
    assert.match(d, /NON FIABLES?/)
    assert.match(d, /exécute/)
  }
  assert.match(TOOL_DESCRIPTIONS.sdig_search, /sans pagination|SANS pagination|curseur/i)
  assert.match(TOOL_DESCRIPTIONS.sdig_search, /context_edit/)
  assert.match(TOOL_DESCRIPTIONS.sdig_read, /context_edit/)
  assert.match(TOOL_DESCRIPTIONS.sdig_status, /aucun chemin local/i)
})

// ── Compatibilité SDK officiel ──────────────────────────────────────────────

test('registerTool accepte les trois schémas et émet des JSON Schema stricts en entrée', () => {
  const server = new McpServer({ name: 'sdig-test', version: '0.0.0' })
  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(def.name, {
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations
    }, async () => ({ content: [] }))
    assert.throws(() => server.registerTool(def.name, { inputSchema: def.inputSchema }, async () => ({ content: [] })), /already registered/)
  }
  for (const schema of [searchInputSchema, readInputSchema, statusInputSchema]) {
    const js = toJsonSchemaCompat(normalizeObjectSchema(schema), { strictUnions: true, pipeStrategy: 'input' })
    assert.equal(js.type, 'object')
    assert.equal(js.additionalProperties, false, 'propriétés inconnues refusées au niveau du protocole')
  }
})

test('client MCP réel (InMemoryTransport) : catalogue et JSON schemas exposés', async () => {
  const server = new McpServer({ name: 'sdig-test', version: '0.0.0' })
  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(def.name, {
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations
    }, async () => ({ content: [{ type: 'text', text: 'stub' }] }))
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'sdig-test-client', version: '0.0.0' })
  await client.connect(clientT)
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name).sort(), [...TOOL_NAMES].sort())
    const byName = new Map(tools.map(t => [t.name, t]))
    assert.equal(byName.get('sdig_search').inputSchema.additionalProperties, false)
    assert.equal(byName.get('sdig_read').inputSchema.additionalProperties, false)
    assert.equal(byName.get('sdig_status').inputSchema.additionalProperties, false)
    assert.equal(byName.get('sdig_status').inputSchema.properties.cursor, undefined)
    // sortie search : nextCursor structurellement refusé (jamais requis, jamais émis)
    const out = byName.get('sdig_search').outputSchema
    assert.ok(out && out.properties, 'outputSchema search exposé')
    assert.ok(!(out.required || []).includes('nextCursor'))
  } finally {
    await client.close()
    await server.close()
  }
})

async function connectedStubServer (handlerFor) {
  const server = new McpServer({ name: 'sdig-test', version: '0.0.0' })
  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(def.name, {
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations
    }, handlerFor(def.name))
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'sdig-test-client', version: '0.0.0' })
  await client.connect(clientT)
  return { client, server }
}

test('client MCP réel : callTool search/read valide des sorties synthétiques (ZodObject SDK)', async () => {
  const { client, server } = await connectedStubServer((name) => async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: name === 'sdig_search' ? searchEnvelope : readEnvelope
  }))
  try {
    const s = await client.callTool({ name: 'sdig_search', arguments: { query: 'ok' } })
    assert.notEqual(s.isError, true)
    assert.equal(s.structuredContent.count, 1)
    assert.equal(s.structuredContent.hits[0].ref.messageId, 'msg_u1')
    const r = await client.callTool({ name: 'sdig_read', arguments: { session: 'ses_fix1' } })
    assert.notEqual(r.isError, true)
    assert.equal(r.structuredContent.messages[0].offset, 0)
    assert.equal(r.structuredContent.messages[0].complete, true)
    // l'entrée stricte reste appliquée au niveau protocole (cursor hors read) :
    // le SDK répond isError (la recopie de la clé inconnue est l'obligation de
    // sanitisation M1b documentée, elle n'est pas masquée ici)
    const refused = await client.callTool({ name: 'sdig_search', arguments: { query: 'ok', cursor: 'x' } })
    assert.equal(refused.isError, true)
    assert.equal(refused.structuredContent, undefined)
  } finally {
    await client.close()
    await server.close()
  }
})

test('client MCP réel : erreur applicative isError sans structuredContent (jamais invalidée par outputSchema)', async () => {
  const { client, server } = await connectedStubServer(() => async () => toToolErrorResult(new McpAppError('invalid_params')))
  try {
    const res = await client.callTool({ name: 'sdig_search', arguments: { query: 'ok' } })
    assert.equal(res.isError, true)
    assert.equal(res.structuredContent, undefined)
    assert.deepEqual(JSON.parse(res.content[0].text), { code: 'invalid_params', message: APP_ERROR_MESSAGES.invalid_params })
  } finally {
    await client.close()
    await server.close()
  }
})

// ── Validation search ───────────────────────────────────────────────────────

test('search : valeurs par défaut, source inconnue acceptée, ctx=0 accepté', () => {
  const r = validateSearchInput({ query: 'bug proxy', source: 'martian', ctx: 0 })
  assert.equal(r.value.limit, DEFAULT_SEARCH_LIMIT)
  assert.equal(r.value.ctx, 0)
  assert.equal(r.value.source, 'martian')
  assert.deepEqual(r.adaptations, [])
})

test('search : plafonds valides ramenés avec adaptation explicite', () => {
  const r = validateSearchInput({ query: 'x', limit: 999, ctx: 99 })
  assert.equal(r.value.limit, MAX_SEARCH_HITS)
  assert.equal(r.value.ctx, MAX_SEARCH_CTX)
  assert.deepEqual(r.adaptations.map(a => [a.field, a.requested, a.applied]), [
    ['limit', 999, MAX_SEARCH_HITS],
    ['ctx', 99, MAX_SEARCH_CTX]
  ])
})

test('search : propriétés inconnues et cursor refusés (invalid_params)', () => {
  for (const raw of [{ query: 'x', nope: 1 }, { query: 'x', cursor: 'abc' }]) {
    assert.throws(() => validateSearchInput(raw), e => e.code === 'invalid_params')
  }
})

test('status : {} seulement si omis ; cursor, null, tableau et types refusés', () => {
  assert.deepEqual(validateStatusInput().value, {})
  assert.deepEqual(validateStatusInput({}).value, {})
  for (const raw of [{ cursor: 'abc' }, { anything: true }, null, [], 'x', 3]) {
    assert.throws(() => validateStatusInput(raw), e => e.code === 'invalid_params', JSON.stringify(raw))
  }
})

test('search : types invalides, non-entiers, négatifs, tailles nulles et chaînes trop longues refusés', () => {
  const cases = [
    { query: 'x', limit: '10' },
    { query: 'x', limit: 1.5 },
    { query: 'x', limit: 0 },
    { query: 'x', limit: -3 },
    { query: 'x', ctx: -1 },
    { query: 'x', ctx: 2.2 },
    { query: '' },
    { query: 'x'.repeat(MAX_QUERY_CHARS + 1) },
    { query: 'x', repo: 'r'.repeat(513) },
    { query: 'x', after: Number.MAX_SAFE_INTEGER },
    { query: 'x', after: Number.POSITIVE_INFINITY }
  ]
  for (const raw of cases) {
    assert.throws(() => validateSearchInput(raw), e => e.code === 'invalid_params', JSON.stringify(raw).slice(0, 60))
  }
})

test('search : requête sans lettre ni chiffre refusée', () => {
  assert.throws(() => validateSearchInput({ query: '+++ ---' }), e => e.code === 'invalid_params')
})

test('search : after/before acceptent epoch et chaîne, refusent une chaîne non datable', () => {
  const r = validateSearchInput({ query: 'x', after: '2026-06-10', before: 1_800_000_000_000 })
  assert.equal(typeof r.value.after, 'number')
  assert.equal(r.value.before, 1_800_000_000_000)
  assert.throws(() => validateSearchInput({ query: 'x', after: 'pas-une-date' }), e => e.code === 'invalid_params')
  assert.throws(() => validateSearchInput({ query: 'x', before: -1 }), e => e.code === 'invalid_params')
})

// ── Validation read ─────────────────────────────────────────────────────────

test('read : session requise sans curseur, options bornées, tail/chars nuls refusés', () => {
  const r = validateReadInput({ session: 'ses_1', ctx: 0 })
  assert.equal(r.value.session, 'ses_1')
  assert.equal(r.value.ctx, 0)
  const bare = validateReadInput({ session: 'ses_1' })
  assert.equal(bare.value.ctx, null)
  assert.equal(bare.value.tail, null)
  assert.equal(bare.value.chars, null)
  assert.throws(() => validateReadInput({}), e => e.code === 'invalid_params')
  assert.throws(() => validateReadInput({ session: 's', tail: 0 }), e => e.code === 'invalid_params')
  assert.throws(() => validateReadInput({ session: 's', chars: 0 }), e => e.code === 'invalid_params')
  assert.throws(() => validateReadInput({ session: 's', chars: 1.5 }), e => e.code === 'invalid_params')
  assert.throws(() => validateReadInput({ session: 's', full: 'oui' }), e => e.code === 'invalid_params')
})

test('read : plafonds ctx/tail/chars ramenés avec adaptations', () => {
  const r = validateReadInput({ session: 's', ctx: 999, tail: 999, chars: 999999 })
  assert.equal(r.value.ctx, MAX_READ_CTX)
  assert.equal(r.value.tail, MAX_READ_TAIL)
  assert.equal(r.value.chars, MAX_READ_CHARS)
  assert.deepEqual(r.adaptations.map(a => a.field), ['ctx', 'tail', 'chars'])
})

test('read : curseur seul accepté comme valeur OPAQUE (sans décodage) ; mélange refusé', () => {
  const cursor = 'opaque-cursor-value-not-decoded'
  const r = validateReadInput({ cursor })
  assert.equal(r.value.cursor, cursor)
  for (const extra of [{ session: 's' }, { at: '2026-01-01' }, { ctx: 1 }, { full: true }]) {
    assert.throws(() => validateReadInput({ cursor, ...extra }), e => e.code === 'invalid_params')
  }
})

test('read : curseur vide ou trop long refusé (invalid_params)', () => {
  assert.throws(() => validateReadInput({ cursor: '' }), e => e.code === 'invalid_params')
  assert.throws(() => validateReadInput({ cursor: 'x'.repeat(5000) }), e => e.code === 'invalid_params')
})

test('read : at vide donne invalid_anchor ; at non vide reste opaque (calendrier = M3)', () => {
  assert.throws(() => validateReadInput({ session: 's', at: '' }), e => e.code === 'invalid_anchor')
  assert.throws(() => validateReadInput({ session: 's', at: '   ' }), e => e.code === 'invalid_anchor')
  assert.equal(validateReadInput({ session: 's', at: 'ancre-quelconque' }).value.at, 'ancre-quelconque')
})

test('null/tableau en entrée ne deviennent jamais {} (search/read)', () => {
  for (const raw of [null, [], 'x', 3]) {
    assert.throws(() => validateSearchInput(raw), e => e.code === 'invalid_params')
    assert.throws(() => validateReadInput(raw), e => e.code === 'invalid_params')
  }
})

// ── Erreurs sans écho privé ─────────────────────────────────────────────────

test('appErrorPayload : messages figés par code, jamais le message de l’exception', () => {
  const SECRET = 'sk-live-SUPER-SECRET-42'
  const err = new McpAppError('invalid_params')
  err.message = `${SECRET}${'x'.repeat(600000)}` // message libre hostile
  const payload = appErrorPayload(err)
  assert.equal(payload.code, 'invalid_params')
  assert.equal(payload.message, APP_ERROR_MESSAGES.invalid_params)
  assert.ok(payload.message.length < 200, 'message borné')
  assert.ok(!payload.message.includes(SECRET))
  const result = toToolErrorResult(err)
  const serialized = JSON.stringify(result)
  assert.ok(serialized.length < 500, 'résultat borné')
  assert.ok(!serialized.includes(SECRET))
  assert.deepEqual(appErrorPayload(new Error(SECRET)), { code: 'internal', message: APP_ERROR_MESSAGES.internal })
})

test('appErrorPayload : code muté hors liste fermée => internal, jamais le secret', () => {
  const SECRET = 'sk-live-SUPER-SECRET-42'
  const err = new McpAppError('invalid_params')
  err.code = SECRET
  assert.deepEqual(appErrorPayload(err), { code: 'internal', message: APP_ERROR_MESSAGES.internal })
  const serialized = JSON.stringify(toToolErrorResult(err))
  assert.ok(!serialized.includes(SECRET))
  assert.equal(toToolErrorResult(err).structuredContent, undefined)
})

test('les erreurs de validation ne citent que des noms de champs fermés', () => {
  const SECRET = 'sk-live-SUPER-SECRET-42'
  try {
    validateSearchInput({ query: 'x', limit: 1.5 })
    assert.fail('devait échouer')
  } catch (e) {
    assert.equal(e.message, 'paramètres invalides')
  }
  for (const fn of [
    () => validateSearchInput({ query: 'ok', [SECRET]: SECRET }),
    () => validateSearchInput({ query: 'ok', limit: SECRET }),
    () => validateSearchInput({ query: 'ok', repo: SECRET.repeat(50) }),
    () => validateReadInput({ session: 's', cursor: SECRET })
  ]) {
    assert.throws(fn, e => {
      assert.ok(!String(e.message).includes(SECRET), 'aucun écho du secret')
      return e.code === 'invalid_params'
    })
  }
})

// ── Schémas de sortie : contrat MCP, pas copie du CLI ───────────────────────

test('search : sortie typée (hits/voisins/groupes), nextCursor refusé partout, additifs tolérés', () => {
  assert.ok(searchOutputSchema.safeParse(searchEnvelope).success)
  assert.ok(searchOutputSchema.safeParse({ ...searchEnvelope, extraFuture: 1 }).success, 'champ additif toléré')
  assert.ok(!searchOutputSchema.safeParse({ ...searchEnvelope, nextCursor: 'x' }).success, 'nextCursor racine refusé')
  assert.ok(!searchTruncationSchema.safeParse({ dimensions: [], nextCursor: 'x' }).success, 'nextCursor truncated refusé')
  assert.ok(searchTruncationSchema.safeParse({ dimensions: [] }).success)
  // titre : référence session seule, sans faux message
  const titleHit = { ...hit, kind: 'title', ref: refTitle, excerpt: { text: 't', truncated: false } }
  assert.ok(searchOutputSchema.safeParse({ ...searchEnvelope, hits: [titleHit] }).success)
  // `count`/`topK` sont requis et typés ; la cohérence count === hits.length est
  // un invariant de handler (M2), pas une contrainte de schéma.
  assert.ok(!searchOutputSchema.safeParse({ ...searchEnvelope, count: undefined, topK: undefined }).success)
})

test('read : fragments offset/end/complete obligatoires, adaptations, freshness, nextCursor autorisé', () => {
  assert.ok(readOutputSchema.safeParse(readEnvelope).success)
  const withCursor = { ...readEnvelope, truncated: { dimensions: [], nextCursor: 'abc' } }
  assert.ok(readOutputSchema.safeParse(withCursor).success)
  const noOffset = JSON.parse(JSON.stringify(readEnvelope))
  delete noOffset.messages[0].offset
  assert.ok(!readOutputSchema.safeParse(noOffset).success, 'offset obligatoire')
  const noAdaptations = JSON.parse(JSON.stringify(readEnvelope))
  delete noAdaptations.adaptations
  assert.ok(!readOutputSchema.safeParse(noAdaptations).success, 'adaptations obligatoires')
  const noFreshness = JSON.parse(JSON.stringify(readEnvelope))
  delete noFreshness.freshness
  assert.ok(!readOutputSchema.safeParse(noFreshness).success, 'freshness obligatoire')
})

test('status : sortie sans chemin local, freshness obligatoire, compteurs par source null si inconnus', () => {
  assert.ok(statusOutputSchema.safeParse(statusEnvelope).success)
  const withNulls = {
    ...statusEnvelope,
    sources: { pi: { available: false, ingested: false, watermark: null, counts: { sessions: null, events: null } } }
  }
  assert.ok(statusOutputSchema.safeParse(withNulls).success, 'compteurs inconnus = null acceptés')
  const noCounts = { ...statusEnvelope, sources: { pi: { available: false, ingested: false, watermark: null } } }
  assert.ok(!statusOutputSchema.safeParse(noCounts).success, 'counts requis (null explicite, jamais omis)')
  const noFreshness = { ...statusEnvelope }
  delete noFreshness.freshness
  assert.ok(!statusOutputSchema.safeParse(noFreshness).success)
})

test('freshness : indexMtime fractionnaire et corpusVersion entier (layout) ; chaîne refusée', () => {
  const mk = (freshness) => readOutputSchema.safeParse({ ...readEnvelope, freshness })
  assert.ok(mk({ sources: {}, indexMtime: 123.456, corpusVersion: LAYOUT_VERSION }).success)
  assert.ok(mk({ sources: {}, indexMtime: null, corpusVersion: null }).success)
  assert.ok(!mk({ sources: {}, indexMtime: 123.456, corpusVersion: String(LAYOUT_VERSION) }).success, 'corpusVersion chaîne refusée')
  assert.ok(!mk({ sources: {}, indexMtime: Number.POSITIVE_INFINITY, corpusVersion: LAYOUT_VERSION }).success, 'indexMtime infini refusé')
  assert.ok(!mk({ sources: {}, indexMtime: 1.5, corpusVersion: -1 }).success, 'corpusVersion négatif refusé')
})

test('fidelity : les deux limites doivent être EXACTEMENT celles du format commun', () => {
  const arbitrary = { ...hit, source: 'pi', fidelity: { source: 'pi', general: true, limits: ['a', 'b'], note: 'n' } }
  assert.ok(!searchOutputSchema.safeParse({ ...searchEnvelope, hits: [arbitrary] }).success, 'limites arbitraires refusées')
  const real = {
    ...hit,
    source: 'pi',
    fidelity: { source: 'pi', general: true, limits: [...PI_FIDELITY_LIMITS], note: PI_FIDELITY_NOTE }
  }
  assert.ok(searchOutputSchema.safeParse({ ...searchEnvelope, hits: [real] }).success, 'valeurs exactes du format commun acceptées')
})

// ── Champs communs avec le CLI (noms justifiés, pas de parse brut) ──────────

test('les noms de champs communs existent bien dans les sorties CLI', () => {
  const slice = sessionSlice(root, 'ses_fix1')
  assert.ok(slice)
  const cliRead = JSON.parse(renderReadJson(slice, 'ses_fix1'))
  for (const k of ['sessionId', 'title', 'repo', 'anchor', 'maskedCount', 'visible', 'total', 'messages']) {
    assert.ok(Object.hasOwn(cliRead, k), `read CLI porte ${k}`)
  }
  assert.ok(Object.hasOwn(cliRead.messages[0], 'id'))
  assert.ok(Object.hasOwn(cliRead.messages[0], 'text'))

  const hits = search(path.join(root, 'index.db'), { q: 'proxy', limit: 5, plain: true })
  assert.ok(hits.length > 0)
  const cliHits = JSON.parse(renderJson(hits))
  for (const k of ['id', 'sessionId', 'ts', 'role', 'source', 'score']) {
    assert.ok(Object.hasOwn(cliHits[0], k), `hit CLI porte ${k}`)
  }
  // mapping explicite CLI → contrat MCP, puis validation du contrat
  const mapped = cliHits.map(h => ({
    kind: h.role === 'title' ? 'title' : 'message',
    ref: { sessionId: h.sessionId, messageId: h.role === 'title' ? null : h.id },
    ts: h.ts,
    date: h.date,
    role: h.role,
    source: h.source,
    score: h.score,
    excerpt: { text: h.snippet ?? '', truncated: false }
  }))
  assert.ok(searchOutputSchema.safeParse({ ...searchEnvelope, hits: mapped, count: mapped.length, topK: 5 }).success)
  // une sortie CLI BRUTE ne passe pas comme sortie MCP complète
  assert.ok(!searchOutputSchema.safeParse(cliHits).success)
})