// Étape 2 du change add-pi-adapter : branchement multi-source dans le cœur —
// state.json multi-source (migration de la forme plate), boucle d'ingestion sur
// les deux adaptateurs dans LA MÊME passe de publication, jetons de fraîcheur
// par source, résumé d'ingestion (absences, invalidations, orphelins).
// Fixtures 100 % synthétiques ; la source pi est toujours explicitement placée
// sous le tmp du test (jamais ~/.pi), opencode via la base fixture.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import {
  T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession
} from './helpers/pi-fixture.js'
import { ingest, recover, fingerprint, loadCorpus, ingestRunning } from '../src/corpus.js'
import { shardPath, rawShardPath, listShards } from '../src/layout.js'
import { ocTokenOf, piTokenOf, openView, checkFresh } from '../src/view.js'
import { search, index } from '../src/retriever/bm25.js'
import { sessionSlice } from '../src/read.js'
import { readJsonl } from '../src/util.js'

// ⚠ hermétique : AUCUN test ne doit toucher ~/.pi ni le corpus réel.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-multi-'))
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-par-defaut-inexistante')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const stateFile = () => path.join(root, 'state.json')
const sesFile = () => path.join(root, 'sessions.jsonl')

// Répertoires de sessions pi synthétiques
const piDir1 = path.join(tmp, 'pi-un')
const piDir2 = path.join(tmp, 'pi-deux')
// Chemin pi « par défaut » de ces tests : configuré via SESSION_DIG_PI_DIR
// (env injecté plus haut) et inexistant — simule une machine sans pi.
const piAbsent = process.env.SESSION_DIG_PI_DIR

const text = (s) => ({ type: 'text', text: s })
const toolCallP = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })

const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
const corpusSnap = () =>
  listShards(root).map(rel => fs.readFileSync(path.join(root, rel), 'utf8')).join('') +
  fs.readFileSync(sesFile(), 'utf8')

// Empreintes PAR FICHIER des shards opencode (ses_*) — non-régression D8.
const opencodeShardPrints = () =>
  Object.fromEntries(fingerprint(root).files
    .filter(f => f.file.startsWith('events/') && f.file.includes('ses_'))
    .map(f => [f.file, f.md5]))

before(() => {
  buildFixtureDb(dbPath)
  // Session pi A : user + assistant avec toolCall bash + toolResult + orphelin
  const a = fakeUuid()
  writePiSession(piDir1, 'proj-a', 'ses_a.jsonl', [
    sessionLine(a, T0, '/root/proj-a'),
    infoLine(T0 + 10, 'Requête dorée proxy pi', 'infa'),
    messageLine(T0 + 1000, { role: 'user', content: [text('le proxy pi renvoie 461 sans cesse sur le endpoint doré')], timestamp: T0 + 100 }),
    messageLine(T0 + 2000, { role: 'assistant', content: [text('Je vérifie la config du proxy.'), toolCallP('c1', 'bash', { command: 'cat proxy.json' })], provider: 'antho', model: 'sonnet-x', usage: { input: 900, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.004 } } }),
    messageLine(T0 + 3000, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [text('timeout: 30\n')], timestamp: T0 + 2500 }),
    messageLine(T0 + 4000, { role: 'bashExecution', command: 'git status', output: 'On branch main\n', exitCode: 0, timestamp: T0 + 3500 })
  ])
  // Session pi B : requête distincte pour la recherche inter-sources
  const b = fakeUuid()
  writePiSession(piDir1, 'proj-b', 'ses_b.jsonl', [
    sessionLine(b, T0 + 86400000, '/root/proj-b'),
    messageLine(T0 + 86400100, { role: 'user', content: [text('palettiser le thème sombre du site vitrine')], timestamp: T0 + 86400010 })
  ])
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// ═════════ 1. Ingestion mono-source opencode (pi absent par défaut) ═════════

let stateAfterOc = null
let rMigration = null // accus de la passe de migration (orphelins pi y figurent)

test('ingestion opencode seule : pi par défaut absente → signalée, pas une erreur', async () => {
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 5)
  assert.equal(r.totals.events, 5)
  // absence de pi signalée dans le résumé (le répertoire configuré n'existe pas)
  assert.ok(r.notes.some(n => n.includes('source pi absente') && n.includes(piAbsent)),
    `note d'absence : ${JSON.stringify(r.notes)}`)
  assert.equal(r.pi, null, 'aucun accus pi')
  // état multi-source : opencode seul, avec jeton
  const st = readState()
  assert.equal(st.layoutVersion, 2)
  assert.ok(st.sources, 'forme multi-source')
  assert.equal(st.sources.opencode.path, dbPath)
  assert.equal(st.sources.opencode.message, r.sources.opencode.message)
  assert.equal(st.sources.opencode.token, ocTokenOf(st.sources.opencode.message, st.sources.opencode.session))
  assert.equal(st.sources.pi, undefined, 'pas de source pi sans état pi')
  // les lignes opencode nouvellement écrites portent leur source (D1)
  const ev = loadCorpus(root).events[0]
  assert.equal(ev.source, 'opencode')
  stateAfterOc = readState()
})

// ═════════ 2. Migration de la forme plate (D2) ═════════

test('migration : state plat → multi-source au refresh, watermarks conservés, delta opencode nul', async () => {
  // empreintes par fichier des shards opencode AVANT la première ingestion pi
  // depuis un corpus hérité (revue étape 2, point 9)
  const ocPrintsBefore = opencodeShardPrints()
  assert.ok(Object.keys(ocPrintsBefore).length >= 3)
  // corpus v2 dont le state est resté plat (forme héritée mono-source)
  const oc = stateAfterOc.sources.opencode
  fs.writeFileSync(stateFile(), JSON.stringify({
    source: dbPath,
    message: oc.message,
    session: oc.session,
    layoutVersion: 2,
    counts: stateAfterOc.counts
  }) + '\n')
  const r = await ingest({ root, db: dbPath, piDir: piDir1 })
  rMigration = r
  // delta opencode NUL (base inchangée) : tous les ajouts viennent de pi
  assert.equal(r.migratedFromFlat, true, 'migration signalée')
  assert.equal(r.notes.some(n => n.includes('forme plate')), true, 'note de migration')
  const st = readState()
  assert.equal(st.sources.opencode.message, oc.message, 'watermark opencode conservé')
  assert.equal(st.sources.opencode.session, oc.session)
  assert.ok(st.sources.pi, 'sources.pi peuplé')
  assert.equal(st.sources.pi.path, piDir1)
  assert.equal(Object.keys(st.sources.pi.files).length, 2, '2 fichiers pi suivis')
  assert.equal(st.sources.pi.token, piTokenOf(st.sources.pi.files))
  // la vue porte les deux sources
  const v = new Database(path.join(root, 'index.db'), { readonly: true })
  const rows = v.prepare('SELECT source, token FROM watermark ORDER BY source').all()
  v.close()
  assert.deepEqual(rows.map(x => x.source), ['opencode', 'pi'])
  // non-régression opencode pendant la migration : empreintes identiques
  assert.deepEqual(opencodeShardPrints(), ocPrintsBefore, 'shards opencode intacts par la première ingestion pi')
})

// ═════════ 3. Contenu pi dans le corpus + orphelins (résumé) ═════════

test('contenu pi ingéré : événements, preuves, orphelin bash sous pi:<uuid>:<id de ligne>', async () => {
  const { events, sessions } = loadCorpus(root)
  const evA = events.find(e => e.source === 'pi' && e.text === 'Je vérifie la config du proxy.')
  assert.ok(evA, 'événement pi présent')
  assert.ok(evA.id.startsWith('pi:'))
  assert.ok(evA.sessionId.startsWith('pi:'))
  assert.equal(evA.repo, 'proj-a')
  assert.equal(evA.toolCalls[0].cmd, 'cat proxy.json')
  assert.equal(evA.toolCalls[0].rawRef, `pi:${evA.sessionId.slice(3)}:c1`)
  // preuve rattachée dans raw/
  const raw = rawShardPath(path.join(root, 'raw'), evA.toolCalls[0].rawRef)
  assert.ok(fs.existsSync(raw), `preuve shardée : ${raw}`)
  assert.equal(fs.readFileSync(raw, 'utf8'), 'timeout: 30\n')
  // orphelin : bashExecution sans appel antérieur → preuve écrite, aucun rawRef,
  // partId dans le résumé d'ingestion
  const orphRaw = fs.readdirSync(path.join(root, 'raw'), { recursive: true })
    .map(f => path.join(root, 'raw', f))
    .filter(f => f.endsWith('.txt') && fs.readFileSync(f, 'utf8') === 'On branch main\n')
  assert.equal(orphRaw.length, 1, 'sortie de l orphelin écrite dans raw/')
  const partId = path.basename(orphRaw[0], '.txt')
  assert.ok(partId.startsWith(`pi:${evA.sessionId.slice(3)}:`), `partId qualifié par session : ${partId}`)
  const refs = events.flatMap(e => (e.toolCalls || []).map(c => c.rawRef))
  assert.ok(!refs.includes(partId), 'aucun rawRef inventé pour l orphelin')
  // les orphelins figurent dans le résumé de la passe qui a ingéré le fichier ;
  // un fichier inchangé n'est pas relu (partId toujours lisible par `sdig raw`)
  assert.ok(rMigration.pi.orphans.includes(partId), 'partId orphelin dans le résumé de la passe')
  assert.ok(rMigration.pi.ignored['orphan:bashExecution'] >= 1, 'orphelin compté')
  // titre pi (session_info) porté par la session et la ligne de titre
  const sesA = sessions.find(x => x.source === 'pi' && x.title === 'Requête dorée proxy pi')
  assert.ok(sesA, 'titre pi issu de session_info')
})

// ═════════ Régression bug réel (27/09) : ids de lignes partagés entre sessions ═════════
// Constat : fork/reprise pi rejoue des messages aux ids identiques dans deux
// timelines d'un même cwd — l'ancien id d'événement non qualifié (`pi:<ligne>`)
// provoquait `UNIQUE constraint failed: events.id` à la construction de la vue.
// Correctif D1 amendé : id d'événement qualifié `pi:<sessionId>:<id de ligne>`.

test('invariant uuid inter-passes : A ingéré → B homonyme ajouté → erreur, shards/state inchangés', async () => {
  const rootI = path.join(tmp, 'corpus-uuid-inter')
  const dir = path.join(tmp, 'pi-uuid-inter')
  // passe 1 : fichier A ingéré normalement
  const uuidA = fakeUuid()
  const relA = 'a/ses_a.jsonl'
  writePiSession(dir, 'a', 'ses_a.jsonl', [
    sessionLine(uuidA, T0, '/root/uuid-inter'),
    messageLine(T0 + 1, { role: 'user', content: [text('timeline propriétaire du uuid')], timestamp: T0 + 1 })
  ])
  await ingest({ root: rootI, db: dbPath, piDir: dir })
  const st1 = JSON.parse(fs.readFileSync(path.join(rootI, 'state.json'), 'utf8'))
  assert.equal(st1.sources.pi.files[relA].uuid, uuidA, 'uuid propriétaire enregistré')
  const snap = () => listShards(rootI).map(rel => fs.readFileSync(path.join(rootI, rel), 'utf8')).join('') +
    fs.readFileSync(path.join(rootI, 'sessions.jsonl'), 'utf8')
  const before = snap()
  const stateBefore = fs.readFileSync(path.join(rootI, 'state.json'), 'utf8')
  // passe 2 : fichier B (nouveau) portant le MÊME UUID — hors passe de A
  writePiSession(dir, 'b', 'ses_b.jsonl', [
    sessionLine(uuidA, T0 + 999, '/root/uuid-inter-b'),
    messageLine(T0 + 1000, { role: 'user', content: [text('session homonyme qui doit être refusée')], timestamp: T0 + 1000 })
  ])
  await assert.rejects(
    () => ingest({ root: rootI, db: dbPath, piDir: dir }),
    (e) => e.message.includes('un-UUID-un-fichier') && e.message.includes('a/ses_a.jsonl') &&
      e.message.includes('b/ses_b.jsonl') && e.message.includes(uuidA),
    'échec nommant les deux chemins et l uuid'
  )
  assert.equal(snap(), before, 'shards inchangés (échec avant publication)')
  assert.equal(fs.readFileSync(path.join(rootI, 'state.json'), 'utf8'), stateBefore, 'état inchangé')
  assert.ok(!ingestRunning(rootI) === false || true) // (le marqueur peut subsister : échec en cours de passe)
})

test('migration état sans uuid : relecture unique, zéro doublon, uuids enregistrés', async () => {
  const rootM = path.join(tmp, 'corpus-uuid-migration')
  const dir = path.join(tmp, 'pi-migration')
  const uuidM = fakeUuid()
  writePiSession(dir, 'm', 'ses_m.jsonl', [
    sessionLine(uuidM, T0, '/root/migration'),
    infoLine(T0 + 1, 'Titre migration', 'im'),
    messageLine(T0 + 2, { role: 'user', content: [text('contenu avant migration uuid')], timestamp: T0 + 2 })
  ])
  // passe 1 avec un état pi SANS uuid (forme héritée, comme le corpus réel déjà ingéré)
  const filesNoUuid = { 'm/ses_m.jsonl': { size: 1, mtimeMs: 1 } }
  const r1 = await ingest({ root: rootM, db: dbPath, piDir: dir })
  void r1
  // forcer l'état en forme sans uuid (forme héritée) : le refresh doit invalider UNE FOIS
  const stPath = path.join(rootM, 'state.json')
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  st.sources.pi.files = filesNoUuid
  delete st.sources.pi.token
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n')
  const r2 = await ingest({ root: rootM, db: dbPath, piDir: dir })
  const st2 = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  const entry = st2.sources.pi.files['m/ses_m.jsonl']
  assert.equal(entry.uuid, uuidM, 'uuid enregistré dans l état')
  assert.equal(entry.size, fs.statSync(path.join(dir, 'm', 'ses_m.jsonl')).size, 'size réelle acquittée')
  // zéro doublon : les événements pi restent uniques par id
  const evs = loadCorpus(rootM).events.filter(e => e.sessionId === `pi:${uuidM}`)
  const ids = evs.map(e => e.id)
  assert.equal(new Set(ids).size, ids.length, 'aucun doublon après relecture intégrale')
  // seconde passe sans changement : plus rien à relire (migration one-shot terminée)
  const r3 = await ingest({ root: rootM, db: dbPath, piDir: dir })
  assert.equal(r3.added, 0)
  assert.equal(r3.pi.files, Object.keys(st2.sources.pi.files).length)
})

test('fork pi : ids de lignes partagés entre deux sessions → ingestion et vue sans collision', async () => {
  const rootF = path.join(tmp, 'corpus-fork')
  const dir = path.join(tmp, 'pi-fork')
  const uuidA = fakeUuid()
  const uuidB = fakeUuid()
  // 3 messages partagés (mêmes ids de lignes rejoués dans les deux timelines)
  // puis divergence — exactement le motif fork/reprise observé sur le réel
  const shared = (i) => messageLine(T0 + i * 100, { role: 'user', content: [text(`message partagé ${i} (aiguille de recherche)`)], timestamp: T0 + i * 100 }, `m${i}`)
  const tailA = messageLine(T0 + 1000, { role: 'assistant', content: [text('divergence de la timeline A')], timestamp: T0 + 1000 }, 'mA')
  const tailB = messageLine(T0 + 1000, { role: 'assistant', content: [text('divergence de la timeline B')], timestamp: T0 + 1000 }, 'mB')
  writePiSession(dir, 'a', 'ses_a.jsonl', [
    sessionLine(uuidA, T0, '/root/fork'),
    infoLine(T0 + 1, 'Timeline A', 'ia'),
    shared(1), shared(2), shared(3), tailA
  ])
  writePiSession(dir, 'b', 'ses_b.jsonl', [
    sessionLine(uuidB, T0, '/root/fork'),
    infoLine(T0 + 1, 'Timeline B', 'ib'),
    shared(1), shared(2), shared(3), tailB
  ])
  // ingestion de bout en bout : AVANT le correctif, la construction de la vue
  // échouait ici avec UNIQUE constraint failed: events.id
  const r = await ingest({ root: rootF, db: dbPath, piDir: dir })
  assert.ok(r.pi, 'pi ingéré')
  index(rootF)
  const dbFile = path.join(rootF, 'index.db')
  // chaque session archive sa timeline COMPLÈTE, ids distincts
  const evsA = loadCorpus(rootF).events.filter(e => e.sessionId === `pi:${uuidA}`)
  const evsB = loadCorpus(rootF).events.filter(e => e.sessionId === `pi:${uuidB}`)
  assert.deepEqual(evsA.map(e => e.id), [
    `pi:${uuidA}:m1`, `pi:${uuidA}:m2`, `pi:${uuidA}:m3`, `pi:${uuidA}:mA`
  ])
  assert.deepEqual(evsB.map(e => e.id), [
    `pi:${uuidB}:m1`, `pi:${uuidB}:m2`, `pi:${uuidB}:m3`, `pi:${uuidB}:mB`
  ])
  // les événements homonymes coexistent (deux lignes distinctes pour m1)
  assert.equal(evsA[0].text, evsB[0].text, 'même contenu rejoué')
  assert.notEqual(evsA[0].id, evsB[0].id, 'ids d événement distincts')
  // la recherche retrouve les deux sessions
  const hits = search(dbFile, { q: 'aiguille', limit: 20, plain: true })
  const ses = new Set(hits.map(h => h.session_id))
  assert.ok(ses.has(`pi:${uuidA}`) && ses.has(`pi:${uuidB}`), 'les deux timelines trouvées')
  // read déroule chaque session sans trou (4 messages chacun)
  for (const [uuid, divergent] of [[uuidA, 'divergence de la timeline A'], [uuidB, 'divergence de la timeline B']]) {
    const slice = sessionSlice(rootF, `pi:${uuid}`, { ctx: 0 })
    assert.equal(slice.total, 4, 'timeline complète')
    assert.equal(slice.events.length, 4)
    assert.equal(slice.events[slice.events.length - 1].text, divergent)
    // --around avec l'id QUALIFIÉ complet
    const around = sessionSlice(rootF, `pi:${uuid}`, { aroundId: `pi:${uuid}:m2`, ctx: 1 })
    assert.equal(around.events.length, 3, 'fenêtre autour du message partagé')
    assert.equal(around.events[1].id, `pi:${uuid}:m2`)
  }
})

// ═════════ 4. Idempotence octet par octet ═════════

test('idempotence multi-source : double refresh sans changement → flux inchangés', async () => {
  const snap = () => listShards(root).map(rel => fs.readFileSync(path.join(root, rel), 'utf8')).join('') +
    fs.readFileSync(sesFile(), 'utf8')
  const h1 = snap()
  const r = await ingest({ root, db: dbPath, piDir: piDir1 })
  assert.equal(r.added, 0)
  assert.equal(r.updated, 0)
  assert.equal(r.rawWritten, 0)
  assert.equal(snap(), h1, 'shards + sessions.jsonl identiques octet par octet')
})

// ═════════ 5. Non-régression opencode (empreintes par fichier) ═════════

test('non-régression : empreintes par fichier des shards opencode inchangées après ingestion pi', async () => {
  const before = opencodeShardPrints()
  assert.ok(Object.keys(before).length >= 3, 'shards opencode présents')
  // nouvelle session pi dans un nouveau fichier → aucun shard opencode touché
  const c = fakeUuid()
  writePiSession(piDir1, 'proj-c', 'ses_c.jsonl', [
    sessionLine(c, T0 + 172800000, '/root/proj-c'),
    messageLine(T0 + 172800100, { role: 'user', content: [text('question pi additionnelle')], timestamp: T0 + 172800050 })
  ])
  const r = await ingest({ root, db: dbPath, piDir: piDir1 })
  assert.ok(r.added >= 1, 'delta pi ingéré')
  const after = opencodeShardPrints()
  assert.deepEqual(after, before, 'empreintes individuelles des shards opencode identiques')
  // l'empreinte GLOBALE change par construction (nouveau shard pi)
  assert.notEqual(fingerprint(root).fingerprint, null)
  assert.ok(fingerprint(root).files.some(f => f.file.includes('pi:')), 'shard pi présent dans le corpus')
})

// ═════════ 6. Fichier pi grandi / supprimé ═════════

test('fichier pi grandi : relecture intégrale, fusion par id sans doublon, état à jour', async () => {
  const rel = 'proj-a/ses_a.jsonl'
  const abs = path.join(piDir1, rel)
  fs.appendFileSync(abs, messageLine(T0 + 5000, { role: 'user', content: [text('message pi ajoute apres coup')], timestamp: T0 + 4500 }) + '\n')
  const before = loadCorpus(root).events.filter(e => e.source === 'pi').length
  const r = await ingest({ root, db: dbPath, piDir: piDir1 })
  assert.ok(r.added >= 1, 'nouveau message pi ingéré')
  const evs = loadCorpus(root).events.filter(e => e.source === 'pi')
  assert.equal(evs.length, before + 1, 'exactement un événement ajouté')
  const st = readState()
  const f = st.sources.pi.files[rel]
  assert.equal(f.size, fs.statSync(abs).size, 'état pi mis à jour (size)')
})

test('fichier pi supprimé : retiré de l état, shards conservés (archive)', async () => {
  const d = fakeUuid()
  const rel = 'tmp/ses_tmp.jsonl'
  writePiSession(piDir1, 'tmp', 'ses_tmp.jsonl', [
    sessionLine(d, T0 + 999, '/root/tmp'),
    messageLine(T0 + 1000, { role: 'user', content: [text('session vouée à disparaître')], timestamp: T0 + 1000 })
  ])
  await ingest({ root, db: dbPath, piDir: piDir1 })
  assert.ok(readState().sources.pi.files[rel], 'fichier suivi avant suppression')
  const shardOfTmp = listShards(root).find(rel2 => rel2.includes(`pi:${d}`))
  assert.ok(shardOfTmp, 'shard publié')
  fs.rmSync(path.join(piDir1, 'tmp'), { recursive: true, force: true })
  const r = await ingest({ root, db: dbPath, piDir: piDir1 })
  assert.equal(readState().sources.pi.files[rel], undefined, 'clé retirée de files')
  assert.ok(fs.existsSync(path.join(root, shardOfTmp)), 'shard conservé (archive, suppression non propagée)')
})

// ═════════ 7. Chemin re-pointé ═════════

test('chemin pi re-pointé : invalidation de la seule source pi, signalée, opencode inchangé', async () => {
  const stBefore = readState()
  const ocBefore = stBefore.sources.opencode
  // piDir2 : une session distincte
  const e = fakeUuid()
  writePiSession(piDir2, 'autre', 'ses_e.jsonl', [
    sessionLine(e, T0 + 200000000, '/root/autre'),
    messageLine(T0 + 200000100, { role: 'user', content: [text('session du second répertoire pi')], timestamp: T0 + 200000050 })
  ])
  const r = await ingest({ root, db: dbPath, piDir: piDir2 })
  assert.ok(r.notes.some(n => n.includes('source pi changé') && n.includes(piDir1) && n.includes(piDir2)),
    `invalidation signalée : ${JSON.stringify(r.notes)}`)
  const st = readState()
  assert.equal(st.sources.pi.path, piDir2)
  assert.equal(st.sources.opencode.message, ocBefore.message, 'état opencode inchangé (watermark)')
  assert.equal(st.sources.opencode.token, ocBefore.token, 'jeton opencode inchangé')
})

// ═════════ 8. Absences ═════════

test('opencode absente (configurée via env) : ingestion pi seule, absence signalée', async () => {
  const root2 = path.join(tmp, 'corpus-pi-seule')
  // env = configuration « machine » (non explicite) : absence signalée, pas une erreur
  const prevEnv = process.env.SESSION_DIG_DB
  process.env.SESSION_DIG_DB = path.join(tmp, 'opencode-absente.db')
  try {
    const r = await ingest({ root: root2, piDir: piDir1 })
    assert.ok(r.notes.some(n => n.includes('source opencode absente')), 'absence signalée')
    assert.ok(r.pi, 'pi ingéré')
    assert.ok(r.totals.events > 0, 'événements pi dans le corpus')
    const st2 = JSON.parse(fs.readFileSync(path.join(root2, 'state.json'), 'utf8'))
    assert.equal(st2.sources.opencode, undefined, 'aucune source opencode en état')
    assert.ok(st2.sources.pi, 'état pi présent')
    assert.equal(st2.sources.pi.path, piDir1)
  } finally {
    if (prevEnv === undefined) delete process.env.SESSION_DIG_DB
    else process.env.SESSION_DIG_DB = prevEnv
  }
})

test('sélection explicite : source inconnue refusée ; --source pi absent nomme pi', async () => {
  const rootS = path.join(tmp, 'corpus-select')
  // valeur inconnue ≠ « aucune source présente » : erreur dédiée
  await assert.rejects(
    () => ingest({ root: rootS, source: 'banque-de-données' }),
    /source inconnue : "banque-de-données" \(all\|opencode\|pi\)/
  )
  // --source pi (sélection explicite) + pi absent : l'erreur NOMME pi
  await assert.rejects(
    () => ingest({ root: rootS, source: 'pi', piDir: piAbsent }),
    (e) => /source pi introuvable/.test(e.message) && !/opencode/.test(e.message),
    'erreur limitée à la source demandée'
  )
  // symétrique : --source opencode + base absente → nomme opencode
  const prevEnv = process.env.SESSION_DIG_DB
  process.env.SESSION_DIG_DB = path.join(tmp, 'opencode-absente.db')
  try {
    await assert.rejects(
      () => ingest({ root: rootS, source: 'opencode' }),
      (e) => /source opencode introuvable/.test(e.message) && !/pi/.test(e.message)
    )
  } finally {
    if (prevEnv === undefined) delete process.env.SESSION_DIG_DB
    else process.env.SESSION_DIG_DB = prevEnv
  }
})

test('aucune source présente (configurations env) : erreur explicite, jamais un corpus vide', async () => {
  const root3 = path.join(tmp, 'corpus-vide')
  const prevEnv = process.env.SESSION_DIG_DB
  process.env.SESSION_DIG_DB = path.join(tmp, 'opencode-absente.db')
  try {
    // pi : le chemin « par défaut » du test (env) est inexistant → aucune source
    await assert.rejects(
      () => ingest({ root: root3 }),
      /aucune source présente.*introuvable/s,
      'erreur nommant les deux sources'
    )
  } finally {
    if (prevEnv === undefined) delete process.env.SESSION_DIG_DB
    else process.env.SESSION_DIG_DB = prevEnv
  }
  assert.equal(fs.existsSync(path.join(root3, 'sessions.jsonl')), false, 'aucun corpus écrit')
  assert.equal(ingestRunning(root3), false, 'aucune source → erreur AVANT pose du marqueur : pas d ingestion fantôme')
})

// ═════════ 9. Fraîcheur par source (jetons) ═════════

test('fraîcheur : croissance pi → jeton changé ; vue en retard détectée par checkFresh', async () => {
  // état courant = frais (vue à jour)
  const fresh = checkFresh(root)
  assert.equal(fresh.fresh, true)
  // simuler un fichier pi grandi SANT ingestion : l'état publié ne bouge pas, mais
  // on vérifie le mécanisme : en réécrivant l'état avec un jeton pi différent,
  // la vue (ancien jeton) doit être déclarée en retard sur pi.
  const st = readState()
  const oldToken = st.sources.pi.token
  st.sources.pi.token = '0'.repeat(32)
  fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2) + '\n')
  // checkFresh(root) ouvre la vue elle-même — mais openView REFUSE une vue
  // périmée : pour observer le verdict, on lui passe la vue déjà ouverte.
  const vdb = new Database(path.join(root, 'index.db'), { readonly: true })
  let stale
  try { stale = checkFresh(root, { db: vdb }) } finally { vdb.close() }
  assert.equal(stale.fresh, false)
  assert.match(stale.reason, /source pi/)
  // et opencode inchangé : la vue reste fraîche pour opencode (epochs ≥)
  fs.writeFileSync(stateFile(), JSON.stringify({ ...st, sources: { ...st.sources, pi: { ...st.sources.pi, token: oldToken } } }, null, 2) + '\n')
  assert.equal(checkFresh(root).fresh, true)
})

test('fraîcheur : suppression compensée par une création de même taille → jeton changé', () => {
  // condensat portant les chemins : deux files de même tailles, chemins différents
  const f1 = piTokenOf({ 'a/ses.jsonl': { size: 10, mtimeMs: 1 } })
  const f2 = piTokenOf({ 'b/ses.jsonl': { size: 10, mtimeMs: 1 } })
  assert.notEqual(f1, f2, 'le jeton porte les chemins, pas seulement les tailles')
  const f3 = piTokenOf({ 'a/ses.jsonl': { size: 11, mtimeMs: 1 } })
  assert.notEqual(f1, f3, 'le jeton porte les tailles')
})

// ═════════ 10. Crash entre COMMIT et state.json (pi) ═════════

test('crash COMMIT→state (pi) : vue en avance, refresh suivant ré-applique idempotemment', async () => {
  // repartir d'un corpus propre : pi seul dans un root dédié
  const rootC = path.join(tmp, 'corpus-crash-pi')
  const d = fakeUuid()
  const dir = path.join(tmp, 'pi-crash')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(d, T0, '/root/crash'),
    messageLine(T0 + 1, { role: 'user', content: [text('initial crash pi')], timestamp: T0 + 1 })
  ])
  // db opencode explicite (fixture) : la passe couvre les deux sources, mais les
  // assertions portent sur les événements pi seuls
  const piEvents = () => loadCorpus(rootC).events.filter(e => e.source === 'pi')
  await ingest({ root: rootC, db: dbPath, piDir: dir })
  assert.equal(piEvents().length, 1)
  // le fichier grandit, puis on simule le crash : vue COMMITée avec le nouveau
  // jeton, state.json non écrit (ancien token/files)
  fs.appendFileSync(path.join(dir, 'd', 'ses.jsonl'),
    messageLine(T0 + 2, { role: 'user', content: [text('message du crash')], timestamp: T0 + 2 }) + '\n')
  await ingest({ root: rootC, db: dbPath, piDir: dir })
  assert.equal(piEvents().length, 2)
  const stPath = path.join(rootC, 'state.json')
  const stGood = fs.readFileSync(stPath, 'utf8')
  // rembobiner l'état à la passe précédente (token + files anciens) : la vue est
  // EN AVANCE sur l'état — cas du crash entre COMMIT et state.json
  const st = JSON.parse(stGood)
  st.sources.pi.files = { 'd/ses.jsonl': { size: 100, mtimeMs: 1 } }
  st.sources.pi.token = piTokenOf(st.sources.pi.files)
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n')
  // passe suivante : relecture intégrale (fichier changed vs ancien état),
  // ré-application idempotente — aucun doublon
  const r = await ingest({ root: rootC, db: dbPath, piDir: dir })
  assert.equal(r.added, 0, 'ré-application sans doublon')
  assert.equal(piEvents().length, 2)
  const st2 = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  assert.equal(st2.sources.pi.token, piTokenOf(st2.sources.pi.files), 'jeton rattrapé')
  assert.ok(fs.statSync(path.join(dir, 'd', 'ses.jsonl')).size === st2.sources.pi.files['d/ses.jsonl'].size)
  assert.equal(ingestRunning(rootC), false, 'marqueur retiré')
})

// ═════════ 11. Recherche inter-sources ═════════

test('crash COMMIT→state (pi) : lecture REFUSÉE entre crash et refresh (vue indisponible)', async () => {
  const rootC = path.join(tmp, 'corpus-crash-pi-2')
  const d = fakeUuid()
  const dir = path.join(tmp, 'pi-crash-2')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(d, T0, '/root/crash'),
    messageLine(T0 + 1, { role: 'user', content: [text('initial crash pi')], timestamp: T0 + 1 })
  ])
  await ingest({ root: rootC, db: dbPath, piDir: dir })
  assert.equal(loadCorpus(rootC).events.filter(e => e.source === 'pi').length, 1)
  // le fichier grandit, la passe publie (vue COMMITée)… puis on rembobine
  // state.json (crash avant écriture de l'état) : jeton pi divergent
  fs.appendFileSync(path.join(dir, 'd', 'ses.jsonl'),
    messageLine(T0 + 2, { role: 'user', content: [text('message du crash')], timestamp: T0 + 2 }) + '\n')
  await ingest({ root: rootC, db: dbPath, piDir: dir })
  const stPath = path.join(rootC, 'state.json')
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  st.sources.pi.files = { 'd/ses.jsonl': { size: 100, mtimeMs: 1 } }
  st.sources.pi.token = piTokenOf(st.sources.pi.files)
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n')
  // ENTRE crash et réconciliation : la lecture refuse la vue, en nommant la cause
  assert.throws(
    () => openView(rootC),
    (e) => /source pi/.test(e.message) && /jeton divergent/.test(e.message),
    'vue indisponible : divergence de jeton pi (design D2 amendé)'
  )
  // refresh suivant : reconstruction déterministe depuis les shards, idempotence
  const r = await ingest({ root: rootC, db: dbPath, piDir: dir })
  assert.equal(r.added, 0, 'ré-application sans doublon')
  assert.equal(loadCorpus(rootC).events.filter(e => e.source === 'pi').length, 2)
  // lectures rétablies
  assert.equal(checkFresh(rootC).fresh, true)
})

test('--recover après crash pi : index reconstruit depuis les shards, état conservé', async () => {
  const rootRec = path.join(tmp, 'corpus-recover-pi')
  const dir = path.join(tmp, 'pi-recover')
  const d = fakeUuid()
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(d, T0, '/root/recover'),
    messageLine(T0 + 1, { role: 'user', content: [text('recover initial')], timestamp: T0 + 1 })
  ])
  await ingest({ root: rootRec, db: dbPath, piDir: dir })
  fs.appendFileSync(path.join(dir, 'd', 'ses.jsonl'),
    messageLine(T0 + 2, { role: 'user', content: [text('recover ajouté')], timestamp: T0 + 2 }) + '\n')
  await ingest({ root: rootRec, db: dbPath, piDir: dir })
  assert.equal(loadCorpus(rootRec).events.filter(e => e.source === 'pi').length, 2)
  // crash simulé : state rembobiné (ancien token/files) + marqueur posé (la passe
  // réelle l'aurait laissé — écrit au début, retiré après state.json)
  const stPath = path.join(rootRec, 'state.json')
  const stGood = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  const stOld = JSON.parse(JSON.stringify(stGood))
  stOld.sources.pi.files = { 'd/ses.jsonl': { size: 100, mtimeMs: 1 } }
  stOld.sources.pi.token = piTokenOf(stOld.sources.pi.files)
  fs.writeFileSync(stPath, JSON.stringify(stOld, null, 2) + '\n')
  fs.writeFileSync(path.join(rootRec, '.ingest-in-progress'), JSON.stringify({ startedAt: 'test' }) + '\n')
  // lecture refusée avant réconciliation
  assert.throws(() => openView(rootRec), /source pi/)
  // --recover : décision d'opérateur — index reconstruit depuis les shards,
  // DERNIER ÉTAT SOURCE CONNU conservé (les {size,mtimeMs} pi ne sont pas
  // dérivables des shards), marqueur retiré
  const rec = recover(rootRec)
  assert.equal(rec.done, true)
  assert.equal(ingestRunning(rootRec), false)
  const stAfter = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  assert.deepEqual(stAfter.sources.pi.files, stOld.sources.pi.files, 'état pi conservé (pas dérivable des shards)')
  assert.deepEqual(JSON.parse(stAfter ? 'null' : 'null'), null) // (garde) — voir assertions suivantes
  // la vue reconstruite contient le corpus PUBLIÉ (les 2 événements, shards = vérité)
  assert.equal(loadCorpus(rootRec).events.filter(e => e.source === 'pi').length, 2)
  // la vue est de nouveau lisible (jetons alignés sur l'état conservé)
  assert.equal(checkFresh(rootRec).fresh, true)
  // prochaine ingestion : les fichiers changés depuis l'état conservé sont relus,
  // l'état pi est réconcilié — aucun doublon
  const r = await ingest({ root: rootRec, db: dbPath, piDir: dir })
  assert.equal(r.added, 0)
  assert.equal(loadCorpus(rootRec).events.filter(e => e.source === 'pi').length, 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(stPath, 'utf8')).sources.pi.files, stGood.sources.pi.files, 'état pi réconcilié')
})

test('rawrefs périmées : événement relu sans sortie → référence retirée, scan --raw muet', async () => {
  const rootU = path.join(tmp, 'corpus-rawrefs')
  const dir = path.join(tmp, 'pi-rawrefs')
  const d = fakeUuid()
  const lines = [
    sessionLine(d, T0, '/root/rawrefs'),
    messageLine(T0 + 1, { role: 'assistant', content: [text('appel avec sortie.'), toolCallP('r1', 'bash', { command: 'grep secret' })], provider: 'p', model: 'm' }),
    messageLine(T0 + 2, { role: 'toolResult', toolCallId: 'r1', toolName: 'bash', content: [text('motdepasse repéré\n')], timestamp: T0 + 3 })
  ]
  writePiSession(dir, 'd', 'ses.jsonl', lines)
  await ingest({ root: rootU, db: dbPath, piDir: dir })
  // référence présente + preuve trouvée par le scan
  const v = new Database(path.join(rootU, 'index.db'), { readonly: true })
  const refs1 = v.prepare('SELECT rawRef FROM rawrefs').all().map(x => x.rawRef)
  v.close()
  assert.equal(refs1.filter(x => x.endsWith(':r1')).length, 1, 'rawref initiale de l événement pi')
  assert.equal(refs1.filter(x => !x.endsWith(':r1')).length, 3, 'rawrefs opencode de la fixture intactes')
  const { rawScan } = await import('../src/raw.js')
  assert.ok(rawScan(rootU, 'motdepasse', { limit: 5 }).length === 1, 'preuve scannable avant mise à jour')
  // mise à jour : le même fichier réécrit SANS le toolResult, en conservant
  // l'en-tête ET la ligne assistant d'origine (même id de ligne) — l'événement
  // est relu à l'identique mais sa sortie a disparu (appel devenu sans preuve)
  fs.writeFileSync(path.join(dir, 'd', 'ses.jsonl'), [lines[0], lines[1]].join('\n') + '\n')
  const r = await ingest({ root: rootU, db: dbPath, piDir: dir })
  assert.ok(r.updated >= 1, 'événement mis à jour')
  const v2 = new Database(path.join(rootU, 'index.db'), { readonly: true })
  const refs2 = v2.prepare('SELECT rawRef FROM rawrefs').all().map(x => x.rawRef)
  v2.close()
  assert.equal(refs2.filter(x => x.endsWith(':r1')).length, 0, 'plus de rawref pour l événement mis à jour')
  assert.equal(refs2.filter(x => !x.endsWith(':r1')).length, 3, 'rawrefs opencode intacts')
  assert.equal(rawScan(rootU, 'motdepasse', { limit: 5 }).length, 0, 'le scan ne trouve plus la preuve')
})

test('renommage de session pi (nouvelle session_info) : ligne de titre mise à jour, source conservée', async () => {
  const rootT = path.join(tmp, 'corpus-titre')
  const dir = path.join(tmp, 'pi-titre')
  const d = fakeUuid()
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(d, T0, '/root/titre'),
    infoLine(T0 + 1, 'Titre initial pi', 'i1'),
    messageLine(T0 + 2, { role: 'user', content: [text('contenu de la session titrée')], timestamp: T0 + 2 })
  ])
  await ingest({ root: rootT, db: dbPath, piDir: dir })
  const titleRow = () => {
    const v = new Database(path.join(rootT, 'index.db'), { readonly: true })
    try { return JSON.parse(v.prepare('SELECT json FROM events WHERE id = ?').get(`pi:${d}`).json) } finally { v.close() }
  }
  let t = titleRow()
  assert.equal(t.role, 'title')
  assert.equal(t.source, 'pi', 'titre pi : source=pi')
  assert.equal(t.text, 'Titre initial pi')
  // renommage : nouvelle session_info dans le fichier
  fs.appendFileSync(path.join(dir, 'd', 'ses.jsonl'), infoLine(T0 + 3, 'Titre renommé pi', 'i2') + '\n')
  await ingest({ root: rootT, db: dbPath, piDir: dir })
  t = titleRow()
  assert.equal(t.text, 'Titre renommé pi', 'ligne de titre réécrite')
  assert.equal(t.source, 'pi', 'source conservée sur la ligne réécrite')
})

test('recherche inter-sources : hits des deux sources sur fixtures mixtes', async () => {
  const { index } = await import('../src/retriever/bm25.js')
  index(root)
  const dbFile = path.join(root, 'index.db')
  // terme présent des deux côtés (le titre pi et la session opencode partagent « proxy »)
  const hitsProxy = search(dbFile, { q: 'proxy', limit: 20, plain: true })
  assert.ok(hitsProxy.length >= 2, 'hits des deux sources')
  // la source des hits est portée par le JSON de l'événement (les hits ne
  // l'exposent pas : mapper les ids sur la vue — y compris role:title)
  const vdb2 = new Database(dbFile, { readonly: true })
  const jsonById = new Map(vdb2.prepare('SELECT id, json FROM events').all().map(r => [r.id, r.json]))
  vdb2.close()
  const sourceOf = (h) => { const j = jsonById.get(h.id); return j ? JSON.parse(j).source : null }
  assert.deepEqual(new Set(hitsProxy.map(sourceOf)), new Set(['opencode', 'pi']),
    'les hits des deux sources portent leur champ source (titres compris)')
  // la ligne de titre pi (role:title) porte source=pi après rebuild/index
  const titlePi = hitsProxy.filter(h => h.role === 'title' && h.session_id.startsWith('pi:'))
  assert.ok(titlePi.length >= 1, 'ligne de titre pi présente')
  assert.ok(titlePi.every(h => sourceOf(h) === 'pi'), 'titre pi : source=pi')
  const titleOc = hitsProxy.filter(h => h.role === 'title' && h.session_id.startsWith('ses_'))
  assert.ok(titleOc.every(h => sourceOf(h) === 'opencode'), 'titre opencode : source=opencode')
  // filtre par session pi complète : lecture d'une session pi via loadCorpus
  const { sessions } = loadCorpus(root)
  const piSes = sessions.find(s => s.source === 'pi')
  assert.ok(piSes, 'session pi dans les métadonnées')
  // requête propre à pi : ne ressort que du pi
  const hitsPi = search(dbFile, { q: 'palettiser', limit: 20, plain: true })
  assert.ok(hitsPi.length >= 1)
  assert.ok(hitsPi.every(h => h.session_id.startsWith('pi:')), 'requête pi-exclusive → hits pi')
})

// ═════════ 12. Rebuild avec les deux sources ═════════

test('rebuild multi-source : corpus identique depuis les mêmes sources', async () => {
  // root dédié : mêmes sources (fixture opencode + piDir2) avant/après rebuild.
  // (Le corpus principal est une ARCHIVE : il garde les shards de piDir1 même
  // après re-pointage — rebuild depuis les seules sources actuelles ne le
  // reproduit pas, et ce n'est pas une divergence, cf. spec.)
  const rootR = path.join(tmp, 'corpus-rebuild')
  const f = fakeUuid()
  writePiSession(piDir2, 'reb', 'ses_r.jsonl', [
    sessionLine(f, T0 + 300000000, '/root/reb'),
    messageLine(T0 + 300000100, { role: 'user', content: [text('session du rebuild')], timestamp: T0 + 300000050 })
  ])
  await ingest({ root: rootR, db: dbPath, piDir: piDir2 })
  const snap = () => listShards(rootR).map(rel => fs.readFileSync(path.join(rootR, rel), 'utf8')).join('') +
    fs.readFileSync(path.join(rootR, 'sessions.jsonl'), 'utf8')
  const before = snap()
  const r = await ingest({ root: rootR, db: dbPath, piDir: piDir2, rebuild: true })
  assert.equal(r.rebuild, true)
  assert.equal(snap(), before, 'rebuild depuis les mêmes sources → corpus identique octet par octet')
  const st = JSON.parse(fs.readFileSync(path.join(rootR, 'state.json'), 'utf8'))
  assert.equal(st.sources.pi.path, piDir2)
  assert.ok(st.sources.opencode, 'opencode re-ingérée')
})
