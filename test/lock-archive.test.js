// Lot A2 : tests multiprocessus RÉELS de la protection par verrou consultatif de
// TOUTE l'opération d'archive — buildView/index (rebuild), fingerprint, migrate
// (v1 ET chemin déjà v2), recover — et la direction réciproque (ingestion/verrou
// actif → archive refusée sans mutation). Fixtures 100 % synthétiques dans un
// répertoire temporaire dédié (jamais ~/.pi ni la vraie base opencode), barrières
// IPC explicites aux points fs APRÈS le contrôle initial (aucun setTimeout comme
// synchronisation — WAIT_MS n'est qu'un filet de sécurité), enfants tués puis
// ATTENDUS avant la suppression du tmp. Les garanties restent COOPÉRATIVES
// (best effort) : ces tests couvrent les acteurs qui empruntent le verrou,
// pas un retrait externe du fichier (lot A3/A4, hors portée ici).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import Database from 'better-sqlite3'
import { CorpusLock, ingest, recover, fingerprint, migrate, ingestRunning } from '../src/corpus.js'
import { buildView } from '../src/view.js'
import { shardPrefix } from '../src/layout.js'
import { buildFixtureDb, T0 } from './helpers/fixture.js'

const ARCHIVE_HELPER = fileURLToPath(new URL('./helpers/archive-child.js', import.meta.url))
const LOCK_HELPER = fileURLToPath(new URL('./helpers/lock-child.js', import.meta.url))
const WAIT_MS = 10000
const KILL_MS = 5000

// ── Enfant piloté par IPC : les messages SONT les barrières ──
class Child {
  constructor (helper, env, stdio = ['pipe', 'pipe', 'pipe', 'ipc']) {
    this.msgs = []
    this.waiters = []
    this.exited = null
    this.stderr = ''
    const childEnv = { ...process.env, ...env }
    delete childEnv.NODE_OPTIONS
    this.proc = fork(helper, [], { env: childEnv, stdio })
    this.proc.stderr.on('data', (d) => { this.stderr += d })
    this.proc.on('message', (m) => this._deliver(m))
    this.exit = new Promise((resolve) => {
      this.proc.on('exit', (code, signal) => {
        this.exited = { code, signal }
        this._deliver({ type: '__exit', code, signal })
        resolve(this.exited)
      })
    })
  }

  get pid () { return this.proc.pid }
  get stdin () { return this.proc.stdin }

  _deliver (m) {
    const i = this.waiters.findIndex((w) => w.types.includes(m.type))
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0]
      clearTimeout(w.timer)
      w.resolve(m)
    } else {
      this.msgs.push(m)
    }
  }

  waitAny (types, ms = WAIT_MS) {
    // Pattern A1 : consommer TOUT message déjà en queue correspondant aux types —
    // pas seulement '__exit'. Sinon ready/paused/done livrés avant l'abonnement
    // resteraient dans la queue et la barrière attendrait jusqu'au timeout.
    const i = this.msgs.findIndex((m) => types.includes(m.type))
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { types, resolve, timer: null }
      w.timer = setTimeout(() => {
        const j = this.waiters.indexOf(w)
        if (j >= 0) this.waiters.splice(j, 1)
        reject(new Error(`timeout ${ms} ms en attente de [${types.join('|')}] — stderr enfant: ${this.stderr || '(vide)'}`))
      }, ms)
      this.waiters.push(w)
    })
  }

  // Reprise d'une pause : UN octet sur stdin (barrière explicite, pas un délai).
  resume () { this.proc.stdin.write(Buffer.alloc(1, 1)) }

  send (cmd) { this.proc.send({ cmd }) }
  kill () { if (this.exited == null) { try { this.proc.kill('SIGKILL') } catch {} } }
}

// Nettoyage systématique : tuer TOUS les enfants d'abord, puis attendre la sortie
// OBSERVÉE de chacun. La deadline est un filet de sécurité qui REJETTE — le test
// échoue et le répertoire n'est PAS supprimé tant qu'une sortie n'est pas constatée
// (jamais de rmSync sous un enfant potentiellement encore vivant, jamais de
// temporisation qui masquerait un enfant mort-vivant).
async function killAndWait (children) {
  for (const c of children) c.kill()
  await Promise.all(children.map((c) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`l’enfant ${c.pid} n’a pas quitté ${KILL_MS} ms après le kill — répertoire NON supprimé, processus encore vivant`)), KILL_MS)
    c.exit.then((ex) => { clearTimeout(timer); resolve(ex) })
  })))
}

// ── Contexte de test : corpus v2 (ou v1) synthétique, sources hermétiques ──
async function ctx (t, { v1 = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-a2-'))
  const __prevPiDir = process.env.SESSION_DIG_PI_DIR
  // Source pi hermétique dans le tmp du test : JAMAIS le ~/.pi réel.
  process.env.SESSION_DIG_PI_DIR = path.join(dir, 'pi-absente')
  const root = path.join(dir, 'corpus')
  const source = path.join(dir, 'source.db')
  buildFixtureDb(source)
  fs.mkdirSync(root, { recursive: true })
  if (v1) writeV1(root)
  else await ingest({ root, db: source })
  const children = []
  t.after(async () => {
    if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
    else process.env.SESSION_DIG_PI_DIR = __prevPiDir
    await killAndWait(children)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const snapshot = () => {
    const out = new Map()
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p, r)
        // hors verrou (éphémère) et -shm de la vue seul (transitoire) : le corpus,
        // la vue elle-même ET son WAL sont couverts octet par octet — SQLite ne
        // modifie la vue que dans le WAL, l'exclure masquerait exactement la
        // mutation que le test veut interdire.
        else if (r !== '.ingest-lock' && r !== 'index.db-shm') out.set(r, fs.readFileSync(p))
      }
    }
    walk(root, '')
    return out
  }
  const spawnArchive = (env) => {
    const c = new Child(ARCHIVE_HELPER, { ARCHIVE_ROOT: root, ARCHIVE_DB: source, ...env })
    children.push(c)
    return c
  }
  const spawnLockHolder = (lockPath) => {
    const c = new Child(LOCK_HELPER, { LOCK_PATH: lockPath }, ['ignore', 'pipe', 'pipe', 'ipc'])
    children.push(c)
    return c
  }
  return {
    dir, root, source,
    paths: { lock: path.join(root, '.ingest-lock'), marker: path.join(root, '.ingest-in-progress'), state: path.join(root, 'state.json') },
    viewDb: path.join(root, 'index.db'),
    expectedEvents: 5,
    snapshot, spawnArchive, spawnLockHolder
  }
}

function assertSameSnapshot (before, after, msg) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${msg} — mêmes fichiers présents`)
  for (const [k, v] of before) {
    assert.ok(after.has(k), `${msg} — ${k} toujours présent`)
    assert.deepEqual(after.get(k), v, `${msg} — octets de ${k} inchangés`)
  }
}

// Corpus v1 synthétique (events.jsonl trié + sessions.jsonl + state plate).
function writeV1 (root) {
  const ev1 = [
    { schemaVersion: 1, id: 'm2', sessionId: 'sa', ts: 2000, role: 'user', text: 'deux', model: {}, repo: null, tokens: {}, cost: 0 },
    { schemaVersion: 1, id: 'm1', sessionId: 'sa', ts: 1000, role: 'user', text: 'un', model: {}, repo: null, tokens: {}, cost: 0 },
    { schemaVersion: 1, id: 'm3', sessionId: 'sb', ts: 3000, role: 'assistant', text: 'trois', model: {}, repo: null, tokens: {}, cost: 0 }
  ]
  fs.writeFileSync(path.join(root, 'events.jsonl'), ev1.map(e => JSON.stringify(e)).join('\n') + '\n')
  fs.writeFileSync(path.join(root, 'sessions.jsonl'), [
    { schemaVersion: 1, id: 'sa', title: 'A', repo: 'r', tsCreated: 0, tsUpdated: 2000, cost: 0, tokens: {} },
    { schemaVersion: 1, id: 'sc', title: 'C sans événement', repo: 'r', tsCreated: 0, tsUpdated: 0, cost: 0, tokens: {} }
  ].map(s => JSON.stringify(s)).join('\n') + '\n')
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ message: 2000, session: 2000, counts: { events: 3, sessions: 2 } }))
}

// Ajout d'un événement inédit dans la SOURCE (fixture opencode) : la passe
// concurrente a un vrai delta à publier, le refus n'est jamais un no-op rassurant.
function addSourceEvent (dbPath, id) {
  const db = new Database(dbPath)
  // au-delà de TOUTES les time_updated de la fixture (max ≈ T0+173 000 000) — sinon
  // l'événement reste sous la watermark et n'est pas vu par le delta
  const t = T0 + 250_000_000
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    .run(id, 'ses_fix1', t, t, JSON.stringify({ role: 'user' }))
  db.close()
}

// ── Direction 1 : archive en cours → une VRAIE ingestion d'un autre processus
// échoue explicitement au verrou, AVANT marqueur/state/shards/index, puis réussit
// après la libération. ──

test('A2-1 : buildView (rebuild) en cours → ingest concurrente refusée au verrou sans mutation, puis delta publié après libération', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  addSourceEvent(c.source, 'msg_delta_a2c1') // vrai delta : la concurrente a du travail réel, le refus n'est pas un no-op rassurant
  const kid = c.spawnArchive({ ARCHIVE_OP: 'buildview', ARCHIVE_PAUSE_FN: 'rmSync', ARCHIVE_PAUSE_MATCH: 'index.db' })
  await kid.waitAny(['ready'])
  kid.send('run')
  await kid.waitAny(['paused']) // barrière : DANS buildView, verrou acquis, rm de l'index pas encore exécuté
  assert.equal(JSON.parse(fs.readFileSync(c.paths.lock, 'utf8')).pid, kid.pid, 'l’enfant détient réellement le verrou')
  const before = c.snapshot()
  assert.ok(fs.existsSync(c.viewDb), 'index.db pas encore effacé (pause au tout début de la mutation)')
  await assert.rejects(() => ingest({ root: c.root, db: c.source }), (e) => {
    assert.match(e.message, /déjà en cours/)
    assert.match(e.message, /verrou consultatif/)
    return true
  }, 'la concurrente échoue explicitement au verrou')
  assert.equal(fs.existsSync(c.paths.marker), false, 'aucun marqueur posé par la concurrente refusée')
  assertSameSnapshot(before, c.snapshot(), 'refus de la concurrente : corpus et vue inchangés (octets)')
  kid.resume()
  const r = await kid.waitAny(['done', 'error'])
  assert.equal(r.type, 'done', `le rebuild de l’enfant a échoué : ${r.message ?? ''}`)
  assert.equal(r.result.events, c.expectedEvents)
  assert.equal(ingestRunning(c.root), false, 'pas de marqueur après rebuild')
  kid.send('exit'); await kid.exit
  // après sortie/libération : l'ingestion repart et PUBLIE le delta mis en attente
  const again = await ingest({ root: c.root, db: c.source })
  assert.equal(again.added, 1, 'le delta source est bien vu (pas de perte par le refus)')
  assert.equal(again.totals.events, c.expectedEvents + 1, 'totals = 5 initiaux + 1 delta')
})

test('A2-2 : index BM25 (chemin CLI `sdig index`) en cours → même exclusion ; l’index reste exploitable après', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  const kid = c.spawnArchive({ ARCHIVE_OP: 'bm25index', ARCHIVE_PAUSE_FN: 'rmSync', ARCHIVE_PAUSE_MATCH: 'index.db' })
  await kid.waitAny(['ready'])
  kid.send('run')
  await kid.waitAny(['paused'])
  assert.equal(JSON.parse(fs.readFileSync(c.paths.lock, 'utf8')).pid, kid.pid)
  const before = c.snapshot()
  await assert.rejects(() => ingest({ root: c.root, db: c.source }), /verrou consultatif/, 'ingestion refusée tant que l’index se reconstruit')
  assertSameSnapshot(before, c.snapshot(), 'refus : octets inchangés')
  kid.resume()
  const r = await kid.waitAny(['done', 'error'])
  assert.equal(r.type, 'done')
  assert.equal(r.result.events, c.expectedEvents)
  assert.equal(r.result.dbFile, c.viewDb)
  kid.send('exit'); await kid.exit
})

// ── Direction 2 : ingestion/verrou actif → TOUTE archive refuse, sans effacer
// l'index ni muter quoi que ce soit. La pause est posée à la TOUTE FIN de
// l'ingestion (retrait du marqueur) : state.json est déjà écrit, le verrou doit
// encore exclure les archives jusqu'à ce dernier retrait. ──

test('A2-3 : ingestion en cours (barrière au retrait du marqueur) → buildView/index/fingerprint/migrate refusés sans mutation, puis succès', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  addSourceEvent(c.source, 'msg_plus') // la passe de l'enfant publie un vrai delta
  const kid = c.spawnArchive({ ARCHIVE_OP: 'ingest', ARCHIVE_PAUSE_FN: 'rmSync', ARCHIVE_PAUSE_MATCH: '.ingest-in-progress' })
  await kid.waitAny(['ready'])
  kid.send('run')
  await kid.waitAny(['paused']) // state.json écrit, marqueur encore présent, verrou tenu
  assert.equal(JSON.parse(fs.readFileSync(c.paths.lock, 'utf8')).pid, kid.pid)
  assert.equal(ingestRunning(c.root), true, 'marqueur encore présent à la barrière')
  const before = c.snapshot()
  assert.throws(() => buildView(c.root), /verrou consultatif/, 'rebuild refusé (verrou, pas seulement marqueur)')
  assert.ok(fs.existsSync(c.viewDb), 'l’index n’a PAS été effacé par l’archive refusée')
  assert.throws(() => fingerprint(c.root), /verrou consultatif/, 'empreinte refusée')
  await assert.rejects(() => migrate(c.root), /verrou consultatif/, 'migration refusée')
  assert.throws(() => recover(c.root), /verrou consultatif/, 'recover refusé aussi — le verrou est acquis AVANT tout contrôle, marqueur présent ou non')
  assertSameSnapshot(before, c.snapshot(), 'les trois refus : octets inchangés')
  kid.resume()
  const r = await kid.waitAny(['done', 'error'])
  assert.equal(r.type, 'done', `l’ingestion de l’enfant a échoué : ${r.message ?? ''}`)
  assert.equal(r.result.added, 1, 'le delta a bien été publié par l’enfant')
  assert.equal(ingestRunning(c.root), false, 'marqueur retiré en tout dernier')
  kid.send('exit'); await kid.exit
  const bv = buildView(c.root) // après libération : l'archive passe
  assert.equal(bv.events, 6)
})

test('A2-4 : fingerprint en cours (pause dans la marche de lecture) → ingest refusée ; empreinte stable après libération', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  const kid = c.spawnArchive({ ARCHIVE_OP: 'fingerprint', ARCHIVE_PAUSE_FN: 'readdirSync', ARCHIVE_PAUSE_MATCH: c.root })
  await kid.waitAny(['ready'])
  kid.send('run')
  await kid.waitAny(['paused']) // SOUS verrou, refus marqueur déjà passé, marche entamée
  assert.equal(JSON.parse(fs.readFileSync(c.paths.lock, 'utf8')).pid, kid.pid)
  const before = c.snapshot()
  await assert.rejects(() => ingest({ root: c.root, db: c.source }), /verrou consultatif/)
  assertSameSnapshot(before, c.snapshot(), 'refus : octets inchangés')
  kid.resume()
  const r = await kid.waitAny(['done', 'error'])
  assert.equal(r.type, 'done')
  const fpChild = r.result.fingerprint
  const fpParent = fingerprint(c.root).fingerprint // après libération : accessible
  assert.equal(fpChild, fpParent, 'empreinte déterministe, calculée sous verrou')
  kid.send('exit'); await kid.exit
})

test('A2-5 : migrate v1 en cours (pause dans le staging des shards) → ingest refusée ; migration complète et cohérente à la reprise', { timeout: 40000 }, async (t) => {
  const c = await ctx(t, { v1: true })
  const kid = c.spawnArchive({ ARCHIVE_OP: 'migrate', ARCHIVE_PAUSE_FN: 'writeFileSync', ARCHIVE_PAUSE_MATCH: '.jsonl.new-' })
  await kid.waitAny(['ready'])
  kid.send('run')
  await kid.waitAny(['paused']) // marqueur migrate posé, shards pas tous écrits
  assert.equal(JSON.parse(fs.readFileSync(c.paths.lock, 'utf8')).pid, kid.pid)
  const before = c.snapshot()
  await assert.rejects(() => ingest({ root: c.root, db: c.source }), /verrou consultatif/, 'refus au VERROU (pas au marqueur) : verrou acquis avant tout contrôle')
  assertSameSnapshot(before, c.snapshot(), 'refus : octets inchangés')
  kid.resume()
  const r = await kid.waitAny(['done', 'error'])
  assert.equal(r.type, 'done', `la migration de l’enfant a échoué : ${r.message ?? ''}`)
  assert.equal(r.result.done, true)
  assert.equal(r.result.coherent, true)
  assert.equal(r.result.events, 3)
  kid.send('exit'); await kid.exit
  const st = JSON.parse(fs.readFileSync(c.paths.state, 'utf8'))
  assert.equal(st.layoutVersion, 2)
  assert.equal(ingestRunning(c.root), false, 'marqueur migrate retiré')
  assert.match(fingerprint(c.root).fingerprint, /^[0-9a-f]{32}$/)
})

test('A2-6 : migrate chemin « déjà v2 » — verrou tenu pendant la re-sharde de raw (pause au renommage) ; ingest refusée', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  const flat = path.join(c.root, 'raw', 'prt_flat.txt')
  fs.writeFileSync(flat, 'preuve brute encore flat (v1 héritée)\n')
  const kid = c.spawnArchive({ ARCHIVE_OP: 'migrate', ARCHIVE_PAUSE_FN: 'renameSync', ARCHIVE_PAUSE_MATCH: 'prt_flat.txt' })
  await kid.waitAny(['ready'])
  kid.send('run')
  await kid.waitAny(['paused']) // DANS shardFlatRaws, sous verrou, renommage pas encore exécuté
  assert.equal(JSON.parse(fs.readFileSync(c.paths.lock, 'utf8')).pid, kid.pid)
  assert.ok(fs.existsSync(flat), 'la preuve flat est encore en place à la barrière')
  const before = c.snapshot()
  await assert.rejects(() => ingest({ root: c.root, db: c.source }), /verrou consultatif/, 'ingest refusée pendant la mutation raw du chemin v2')
  await assert.rejects(() => migrate(c.root), /verrou consultatif/, 'un second migrate est refusé lui aussi')
  assertSameSnapshot(before, c.snapshot(), 'refus : octets inchangés')
  kid.resume()
  const r = await kid.waitAny(['done', 'error'])
  assert.equal(r.type, 'done')
  assert.equal(r.result.done, false, 'chemin déjà v2 : no-op annoncé')
  assert.match(r.result.note, /shardée/)
  kid.send('exit'); await kid.exit
  const moved = path.join(c.root, 'raw', shardPrefix('prt_flat'), 'prt_flat.txt')
  assert.ok(fs.existsSync(moved), 'la preuve flat a bien été shardée par le migrate sous verrou')
  assert.ok(!fs.existsSync(flat))
})

test('A2-7 : recover en cours (pause au rm de l’index via verrou TRANSMIS à buildView) → ingest refusée ; reprise complète sans deadlock', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  fs.writeFileSync(c.paths.marker, '{}\n') // crash simulé : état non réconcilié
  const st = JSON.parse(fs.readFileSync(c.paths.state, 'utf8')); st.counts = { events: 0, sessions: 0 }
  fs.writeFileSync(c.paths.state, JSON.stringify(st))
  const kid = c.spawnArchive({ ARCHIVE_OP: 'recover', ARCHIVE_PAUSE_FN: 'rmSync', ARCHIVE_PAUSE_MATCH: 'index.db' })
  await kid.waitAny(['ready'])
  kid.send('run')
  await kid.waitAny(['paused']) // DANS buildView appelé avec heldLock : verrou tenu, index pas encore effacé
  assert.equal(JSON.parse(fs.readFileSync(c.paths.lock, 'utf8')).pid, kid.pid)
  const before = c.snapshot()
  await assert.rejects(() => ingest({ root: c.root, db: c.source }), /verrou consultatif/, 'refus au VERROU bien que le marqueur soit présent (verrou avant tout contrôle)')
  assert.ok(fs.existsSync(c.viewDb), 'index pas encore effacé')
  assertSameSnapshot(before, c.snapshot(), 'refus : octets inchangés')
  kid.resume()
  const r = await kid.waitAny(['done', 'error'])
  assert.equal(r.type, 'done', `recover a échoué (deadlock d’appel imbriqué ?) : ${r.message ?? ''}`)
  assert.equal(r.result.done, true)
  kid.send('exit'); await kid.exit
  assert.deepEqual(JSON.parse(fs.readFileSync(c.paths.state, 'utf8')).counts, { events: 5, sessions: 3 }, 'comptes recalculés sous verrou')
  assert.equal(ingestRunning(c.root), false, 'marqueur retiré par recover')
})

// ── Marqueur non réconcilié : refus SOUS verrou de toutes les archives — y
// compris sur un corpus déjà v2 — verrou libéré après refus, recover seul autorisé. ──

test('A2-8 : marqueur non réconcilié sur corpus v2 → buildView/fingerprint/migrate refusés sous verrou (verrou libéré après chaque refus), recover autorisé', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  fs.writeFileSync(c.paths.marker, '{}\n')
  const before = c.snapshot()
  assert.throws(() => buildView(c.root), /marqueur/)
  assert.ok(!fs.existsSync(c.paths.lock), 'verrou libéré après le refus')
  const probe = new CorpusLock(c.paths.lock)
  assert.equal(probe.acquire(), true, 'tentative après release : le verrou est libre')
  probe.release()
  assert.throws(() => fingerprint(c.root), /marqueur/)
  assert.ok(!fs.existsSync(c.paths.lock), 'verrou libéré après le refus de fingerprint')
  await assert.rejects(() => migrate(c.root), /marqueur/, 'migrate refuse même sur un corpus déjà v2')
  assertSameSnapshot(before, c.snapshot(), 'les refus au marqueur : octets inchangés (raw v2 non muté)')
  const r = recover(c.root) // seul parcours explicitement autorisé sous son marqueur
  assert.equal(r.done, true)
  assert.equal(ingestRunning(c.root), false)
})

test('A2-9 : marqueur non réconcilié sur corpus v1 → migrate refusé sans rien créer (pas de shards, pas de state v2)', { timeout: 40000 }, async (t) => {
  const c = await ctx(t, { v1: true })
  fs.writeFileSync(c.paths.marker, '{}\n')
  const before = c.snapshot()
  await assert.rejects(() => migrate(c.root), /marqueur/)
  assertSameSnapshot(before, c.snapshot(), 'aucune mutation du corpus v1')
  assert.ok(!fs.existsSync(path.join(c.root, 'events')), 'aucun répertoire events/ créé')
  assert.ok(!fs.existsSync(c.paths.lock), 'verrou libéré')
  const r = recover(c.root)
  assert.equal(r.done, true, 'recover reste autorisé sous son marqueur')
})

// ── heldLock : validation forte (instance, détenue, bon chemin), jamais un
// booléen ; duringRecovery ne contourne PAS le verrou. ──

test('A2-10 : heldLock invalide refusé AVANT toute mutation ; verrou valide transmis sans double acquisition ni libération anticipée', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  const before = c.snapshot()
  assert.throws(() => buildView(c.root, { heldLock: true }), /CorpusLock/, 'un booléen ne peut pas bypasser l’exclusion')
  assert.throws(() => buildView(c.root, { heldLock: new CorpusLock(c.paths.lock) }), /pas détenu/, 'instance mais NON détenue : refus')
  const elsewhere = new CorpusLock(path.join(c.dir, 'autre-verrou'))
  assert.equal(elsewhere.acquire(), true)
  assert.throws(() => buildView(c.root, { heldLock: elsewhere }), /porte sur/, 'verrou d’un AUTRE chemin : refus')
  elsewhere.release()
  assertSameSnapshot(before, c.snapshot(), 'les refus de validation : index non effacé, octets inchangés')
  // Transmission valide (mécanisme exact de recover) : pas de double acquisition,
  // pas de deadlock, et surtout PAS de déverrouillage anticipé par buildView.
  const lock = new CorpusLock(c.paths.lock)
  assert.equal(lock.acquire(), true)
  const bv = buildView(c.root, { heldLock: lock })
  assert.equal(bv.events, c.expectedEvents)
  assert.ok(lock.fd != null, 'buildView n’a PAS libéré le verrou transmis')
  assert.ok(fs.existsSync(c.paths.lock), 'le fichier de verrou reste en place')
  lock.release()
  assert.ok(!fs.existsSync(c.paths.lock), 'release du détenteur : verrou retiré')
})

test('A2-11 : duringRecovery ne désactive pas le verrou ; un refus de verrou ne crée rien dans le corpus', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  const holder = c.spawnLockHolder(c.paths.lock)
  await holder.waitAny(['ready'])
  holder.send('acquire')
  assert.equal((await holder.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  const before = c.snapshot()
  assert.throws(() => buildView(c.root, { duringRecovery: true }), /verrou consultatif/, 'duringRecovery ne contourne pas l’exclusion')
  assertSameSnapshot(before, c.snapshot(), 'refus : octets inchangés')
  // refus de verrou sur un corpus à peine créé : raw/ ne doit PAS être créé par
  // la concurrente (ensureDir(raw) est après l'acquisition)
  const emptyRoot = path.join(c.dir, 'corpus-vierge')
  fs.mkdirSync(emptyRoot)
  const emptyLock = path.join(emptyRoot, '.ingest-lock')
  const holder2 = c.spawnLockHolder(emptyLock)
  await holder2.waitAny(['ready'])
  holder2.send('acquire')
  assert.equal((await holder2.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  await assert.rejects(() => ingest({ root: emptyRoot, db: c.source }), /verrou consultatif/)
  assert.ok(!fs.existsSync(path.join(emptyRoot, 'raw')), 'aucun raw/ créé lors du refus')
})

// ── No-op et exceptions : le verrou est libéré, une tentative après release
// réussit. ──

test('A2-12 : no-op (recover sans marqueur, migrate déjà v2) et exceptions (migrate sans v1, ingest sans source) libèrent le verrou', { timeout: 40000 }, async (t) => {
  const c = await ctx(t)
  const r = recover(c.root) // sans marqueur : no-op SOUS verrou
  assert.equal(r.done, false)
  assert.ok(!fs.existsSync(c.paths.lock), 'no-op recover : verrou libéré')
  const probe1 = new CorpusLock(c.paths.lock)
  assert.equal(probe1.acquire(), true, 'tentative après no-op')
  probe1.release()
  const m = await migrate(c.root) // déjà v2, rien flat : no-op
  assert.equal(m.done, false)
  assert.ok(!fs.existsSync(c.paths.lock), 'no-op migrate : verrou libéré')
  const empty = path.join(c.dir, 'corpus-vide')
  fs.mkdirSync(empty)
  await assert.rejects(() => migrate(empty), /corpus v1 introuvable/, 'exception sous verrou')
  assert.ok(!fs.existsSync(path.join(empty, '.ingest-lock')), 'exception : verrou libéré')
  await assert.rejects(() => ingest({ root: c.root, db: path.join(c.dir, 'gone.db') }), /introuvable/)
  assert.ok(!fs.existsSync(c.paths.lock), 'exception ingest : verrou libéré (finally)')
})

test('A2-13 : messages IPC déjà en queue avant l’abonnement waitAny sont consommés (barrières déterministes, sans délai)', { timeout: 20000 }, async (t) => {
  const c = await ctx(t)
  const kid = c.spawnArchive({ ARCHIVE_OP: 'fingerprint' })
  await kid.waitAny(['ready'])
  // Le listener du Child est enregistré avant celui-ci : sans waiter pour done,
  // il met nécessairement le résultat en queue AVANT cette observation IPC.
  const delivered = new Promise(resolve => kid.proc.once('message', resolve))
  kid.send('run')
  const observed = await delivered
  assert.equal(observed.type, 'done')
  assert.ok(kid.msgs.includes(observed), 'résultat déjà en queue avant waitAny')
  const done = await kid.waitAny(['done', 'error'])
  assert.deepEqual(done, observed, 'waitAny restitue le message déjà reçu')
  assert.ok(!kid.msgs.includes(observed), 'message consommé une seule fois')
  kid.send('exit'); await kid.exit
})
