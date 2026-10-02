// Tests multi-processus ciblés du verrou consultatif (lot A1 — exclusion des
// écrivains par VERROU NOYAU better-sqlite3). Fixtures synthétiques uniquement,
// répertoires jetables, quelques enfants, barrières IPC (aucune synchronisation
// par délai) et nettoyage systématique. Ces tests modélisent la section protégée
// par un journal partagé ; ils ne remplacent pas la campagne de crash A3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { CorpusLock, ingest } from '../src/corpus.js'
import { buildFixtureDb } from './helpers/fixture.js'

const HELPER = fileURLToPath(new URL('./helpers/lock-child.js', import.meta.url))
const WAIT_MS = 10000
const SCHEMA = 'CREATE TABLE lock_owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, at TEXT NOT NULL)'

class Child {
  constructor (env) {
    this.msgs = []
    this.waiters = []
    this.exited = null
    this.stderr = ''
    const childEnv = { ...process.env, ...env }
    delete childEnv.NODE_OPTIONS
    this.proc = fork(HELPER, [], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
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

  resume () { this.proc.stdin.write(Buffer.alloc(1, 1)) }
  send (cmd) { this.proc.send({ cmd }) }
  kill () { if (this.exited == null) { try { this.proc.kill('SIGKILL') } catch {} } }
}

async function killAndWait (children) {
  await Promise.all(children.map((c) => new Promise((resolve) => {
    c.kill()
    const timer = setTimeout(resolve, 2000)
    c.exit.then(() => { clearTimeout(timer); resolve() })
  })))
}

// Lit la trace propriétaire (fichier lisible seulement quand le verrou noyau est
// libre : après release, ou après mort du détenteur). À ne jamais appeler sous
// verrou tenu (SQLITE_BUSY).
function readOwnerPid (lockPath) {
  const db = new Database(lockPath, { readonly: true, fileMustExist: true })
  try {
    const r = db.prepare('SELECT pid FROM lock_owner WHERE id = 1').get()
    return r ? r.pid : null
  } finally { db.close() }
}

function writeStaleLock (lockPath, pid) {
  const db = new Database(lockPath)
  try {
    db.exec(SCHEMA)
    db.prepare('INSERT OR REPLACE INTO lock_owner (id, pid, at) VALUES (1, ?, ?)').run(pid, new Date(0).toISOString())
  } finally { db.close() }
}

function writeUnrelatedDb (lockPath) {
  const db = new Database(lockPath)
  try {
    db.exec('CREATE TABLE other (x INTEGER)')
    db.prepare('INSERT INTO other (x) VALUES (?)').run(42)
  } finally { db.close() }
}

const removeLockArtifacts = (lockPath) => {
  for (const s of ['', '-journal', '-wal', '-shm']) fs.rmSync(lockPath + s, { force: true })
}

function ctx (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-lock-'))
  const lockPath = path.join(dir, '.ingest-lock')
  const logPath = path.join(dir, 'log')
  const children = []
  const spawnChild = (env = {}) => {
    const c = new Child({ LOCK_PATH: lockPath, LOCK_LOG: logPath, ...env })
    children.push(c)
    return c
  }
  t.after(async () => {
    await killAndWait(children)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, lockPath, logPath, spawnChild }
}

test('artefact ambigu (répertoire, vide, illisible, symlink, base SQLite étrangère) : refus conservateur, artefact INTACT', (t) => {
  const { lockPath } = ctx(t)
  // Répertoire au chemin du verrou.
  fs.mkdirSync(lockPath)
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'répertoire')
  assert.ok(fs.statSync(lockPath).isDirectory(), 'répertoire intact')
  fs.rmdirSync(lockPath)
  // Fichier VIDE : refus conservateur, aucun remplissage, octets inchangés.
  fs.writeFileSync(lockPath, '')
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'fichier vide refusé')
  assert.equal(fs.readFileSync(lockPath).length, 0, 'fichier vide inchangé (aucun remplissage)')
  fs.rmSync(lockPath)
  // Fichier non-SQLite.
  const junk = 'pas une base sqlite'
  fs.writeFileSync(lockPath, junk)
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'fichier illisible')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), junk, 'fichier illisible inchangé')
  fs.rmSync(lockPath)
  // Symlink : refus SANS suivre le lien, cible inchangée.
  const target = path.join(path.dirname(lockPath), 'cible.db')
  fs.writeFileSync(target, 'contenu cible intact')
  fs.symlinkSync(target, lockPath)
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'symlink refusé')
  assert.ok(fs.lstatSync(lockPath).isSymbolicLink(), 'symlink intact')
  assert.equal(fs.readFileSync(target, 'utf8'), 'contenu cible intact', 'cible du symlink inchangée')
  fs.rmSync(lockPath)
  fs.rmSync(target)
  // Base SQLite ÉTRANGÈRE (schéma inconnu) : refus, aucune mutation.
  writeUnrelatedDb(lockPath)
  const before = fs.readFileSync(lockPath)
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'base étrangère refusée')
  assert.deepEqual(fs.readFileSync(lockPath), before, 'base étrangère intacte')
  fs.rmSync(lockPath)
  // Les noms de colonnes seuls ne suffisent pas à identifier notre schéma.
  const impostor = new Database(lockPath)
  impostor.exec('CREATE TABLE lock_owner (id INTEGER, pid INTEGER, at TEXT)')
  impostor.close()
  const impostorBytes = fs.readFileSync(lockPath)
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'schéma homonyme mais différent refusé')
  assert.deepEqual(fs.readFileSync(lockPath), impostorBytes, 'schéma homonyme intact')
  fs.rmSync(lockPath)
  const extra = new Database(lockPath)
  extra.exec(SCHEMA)
  extra.exec('CREATE TABLE unrelated (secret TEXT)')
  extra.close()
  const extraBytes = fs.readFileSync(lockPath)
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'table étrangère supplémentaire refusée')
  assert.deepEqual(fs.readFileSync(lockPath), extraBytes, 'base avec table étrangère intacte')
})

test('course de première initialisation : un seul créateur/initialisateur, l’autre refuse sans toucher', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const a = spawnChild(); const b = spawnChild()
  await Promise.all([a.waitAny(['ready']), b.waitAny(['ready'])])
  // Contention depuis un chemin absent : l'ordonnancement reste celui du noyau.
  a.send('acquire'); b.send('acquire')
  const [ra, rb] = await Promise.all([
    a.waitAny(['acquired', 'refused', 'error']),
    b.waitAny(['acquired', 'refused', 'error'])
  ])
  const acquired = [ra, rb].filter((r) => r.type === 'acquired')
  assert.equal(acquired.length, 1, `exactement un acquéreur (obtenu ${acquired.length})`)
  const loser = ra.type === 'acquired' ? rb : ra
  assert.equal(loser.type, 'refused', 'le perdant refuse')
  assert.equal(loser.held, false, 'le perdant ne détient aucune connexion')
  const winner = a.pid === acquired[0].pid ? a : b
  // Sortie brutale du vainqueur : la trace commitée persiste (le perdant ne l’a pas touchée).
  winner.send('abandon')
  await winner.exit
  assert.equal(readOwnerPid(lockPath), winner.pid, 'la trace du vainqueur est commitée et intacte')
  removeLockArtifacts(lockPath)
})

test('initialisation suspendue après réservation : le concurrent refuse sans remplir le fichier vide', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const creator = spawnChild({ LOCK_PAUSE_CREATE: '1' })
  await creator.waitAny(['ready'])
  creator.send('acquire')
  assert.equal((await creator.waitAny(['reserved-before-init', 'error'])).type, 'reserved-before-init')
  assert.equal(fs.statSync(lockPath).size, 0, 'réservation créée, schéma pas encore initialisé')
  const other = spawnChild()
  await other.waitAny(['ready'])
  other.send('acquire')
  const result = await other.waitAny(['acquired', 'refused', 'error'])
  assert.equal(result.type, 'refused', 'refus pendant la fenêtre de première initialisation')
  assert.equal(result.held, false)
  assert.equal(fs.statSync(lockPath).size, 0, 'le concurrent ne remplit pas le fichier réservé')
  creator.resume()
  assert.equal((await creator.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  creator.send('release'); await creator.waitAny(['released'])
  other.send('acquire')
  assert.equal((await other.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  other.send('release'); await other.waitAny(['released'])
  creator.send('exit'); other.send('exit')
  await Promise.all([creator.exit, other.exit])
})

test('cause démontrée : un lecteur SHARED sur fichier 0 o bloque le BEGIN EXCLUSIVE du créateur', (t) => {
  // Reproduit DÉTERMINISTEMENT la fenêtre de première initialisation : un lecteur
  // ouvre le fichier réservé (0 octet) et tient une transaction de lecture pendant
  // que le créateur tente le verrou noyau. `busy_timeout=0` → SQLITE_BUSY : c'est
  // exactement la collision qui faisait refuser les DEUX processus.
  const { lockPath } = ctx(t)
  const fd = fs.openSync(lockPath, 'wx')
  fs.closeSync(fd)
  assert.equal(fs.statSync(lockPath).size, 0, 'réservation vierge (schéma non commité)')
  const reader = new Database(lockPath, { readonly: true, fileMustExist: true })
  try {
    reader.pragma('busy_timeout = 0')
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) AS n FROM sqlite_master').get() // matérialise le verrou SHARED
    const writer = new Database(lockPath)
    try {
      writer.pragma('busy_timeout = 0')
      writer.pragma('journal_mode = MEMORY')
      writer.pragma('locking_mode = EXCLUSIVE')
      assert.throws(() => writer.exec('BEGIN EXCLUSIVE'), (e) => e.code === 'SQLITE_BUSY', 'le lecteur SHARED bloque le créateur')
    } finally { writer.close() }
  } finally { reader.close() }
})

test('course de première initialisation : boucle concurrente (chemins neufs), un seul acquéreur', { timeout: 60000 }, async (t) => {
  // Régression de la collision 0 octet : chaque essai part d'un chemin ABSENT
  // (jamais un état déjà initialisé) et doit produire EXACTEMENT un acquéreur.
  const kids = []
  const dirs = []
  t.after(async () => { await killAndWait(kids) })
  t.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })
  const ROUNDS = 40
  for (let i = 0; i < ROUNDS; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-lock-loop-'))
    dirs.push(dir)
    const lockPath = path.join(dir, '.ingest-lock')
    const a = new Child({ LOCK_PATH: lockPath })
    const b = new Child({ LOCK_PATH: lockPath })
    kids.push(a, b)
    await Promise.all([a.waitAny(['ready']), b.waitAny(['ready'])])
    a.send('acquire')
    b.send('acquire')
    const [ra, rb] = await Promise.all([
      a.waitAny(['acquired', 'refused', 'error']),
      b.waitAny(['acquired', 'refused', 'error'])
    ])
    const acquired = [ra, rb].filter((r) => r.type === 'acquired')
    assert.equal(acquired.length, 1, `essai ${i} : exactement un acquéreur (a=${ra.type}, b=${rb.type})`)
    a.kill(); b.kill()
    await Promise.all([a.exit, b.exit])
  }
  assert.equal(dirs.length, ROUNDS, 'chemin neuf à chaque essai')
})

test('propriétaire vivant (enfant réel) : refus, fichier jamais supprimé, reprise après release', { timeout: 20000 }, async (t) => {
  const { lockPath, logPath, spawnChild } = ctx(t)
  const owner = spawnChild()
  await owner.waitAny(['ready'])
  owner.send('acquire')
  assert.equal((await owner.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  const mine = new CorpusLock(lockPath)
  assert.equal(mine.acquire(), false, 'un propriétaire vivant ne peut pas être dépassé')
  assert.ok(fs.existsSync(lockPath), 'le fichier de verrou n’est jamais supprimé')
  assert.equal(fs.readFileSync(logPath, 'utf8').trim(), `BEGIN ${owner.pid}`)
  owner.send('release')
  assert.equal((await owner.waitAny(['released'])).type, 'released')
  owner.send('exit')
  await owner.exit
  assert.equal(readOwnerPid(lockPath), null, 'trace effacée après release')
  assert.equal(mine.acquire(), true, 'après release, le verrou est libre')
  mine.release()
})

test('propriétaire mort (sortie enfant observée) : le noyau libère, la trace commitée refuse conservativement ; reprise opérateur', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const owner = spawnChild()
  await owner.waitAny(['ready'])
  owner.send('acquire')
  await owner.waitAny(['acquired'])
  owner.send('abandon')
  const ex = await owner.exit
  assert.equal(ex.code, 7, 'sortie brutale réellement observée')
  assert.ok(fs.existsSync(lockPath), 'fichier de verrou laissé en place par le propriétaire mort')
  assert.equal(readOwnerPid(lockPath), owner.pid, 'trace propriétaire persistée (commitée)')
  const contender = new CorpusLock(lockPath)
  assert.equal(contender.acquire(), false, 'aucune reprise automatique : trace commitée = refus conservateur')
  assert.equal(readOwnerPid(lockPath), owner.pid, 'le concurrent n’a pas effacé la trace d’autrui')
  removeLockArtifacts(lockPath)
  assert.equal(contender.acquire(), true, 'après retrait opérateur coordonné, le verrou est réutilisable')
  contender.release()
  assert.equal(readOwnerPid(lockPath), null)
})

test('deux repreneurs sur trace périmée : les deux refusent, l’état reste intact', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const dead = spawnChild()
  await dead.waitAny(['ready'])
  dead.send('exit')
  await dead.exit
  writeStaleLock(lockPath, dead.pid)
  const before = readOwnerPid(lockPath)
  const a = spawnChild(); const b = spawnChild()
  await Promise.all([a.waitAny(['ready']), b.waitAny(['ready'])])
  a.send('acquire'); b.send('acquire')
  const [ra, rb] = await Promise.all([
    a.waitAny(['acquired', 'refused', 'error']),
    b.waitAny(['acquired', 'refused', 'error'])
  ])
  assert.deepEqual([ra.type, rb.type], ['refused', 'refused'], 'aucun des deux repreneurs ne reprend un verrou ambigu')
  assert.equal(readOwnerPid(lockPath), before, 'la trace périmée n’a pas été touchée')
})

test('contention réelle : une seule section protégée, les perdants refusent sans mutation', { timeout: 20000 }, async (t) => {
  const { lockPath, logPath, spawnChild } = ctx(t)
  const kids = [spawnChild(), spawnChild(), spawnChild()]
  await Promise.all(kids.map((k) => k.waitAny(['ready'])))
  for (const k of kids) k.send('acquire')
  const results = await Promise.all(kids.map((k) => k.waitAny(['acquired', 'refused', 'error'])))
  const acquired = results.filter((r) => r.type === 'acquired')
  assert.equal(acquired.length, 1, `exactement une acquisition (obtenu ${acquired.length})`)
  const winner = kids.find((k) => k.pid === acquired[0].pid)
  assert.ok(winner, 'le gagnant est identifié')
  assert.deepEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), [`BEGIN ${winner.pid}`], 'un seul BEGIN tant que le verrou est tenu')
  winner.send('release')
  assert.equal((await winner.waitAny(['released'])).type, 'released')
  winner.send('exit')
  await winner.exit
  assert.deepEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), [`BEGIN ${winner.pid}`, `END ${winner.pid}`], 'aucun entrelacement des sections')
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
  const losers = results.filter((r) => r.type === 'refused').map((r) => r.pid)
  for (const l of losers) assert.ok(!lines.includes(`BEGIN ${l}`) && !lines.includes(`END ${l}`), `aucune ligne de section pour le perdant ${l}`)
  for (const k of kids) if (k.pid !== winner.pid) k.send('exit')
})

test('acquire idempotent ; seconde instance (même process) refusée ; la libération ne supprime jamais le fichier', (t) => {
  const { lockPath } = ctx(t)
  const lock = new CorpusLock(lockPath)
  assert.equal(lock.acquire(), true)
  const db = lock.db
  assert.equal(lock.acquire(), true, 'seconde acquisition : déjà détenu')
  assert.equal(lock.db, db, 'la connexion détenue est conservée')
  const second = new CorpusLock(lockPath)
  assert.equal(second.acquire(), false, 'seconde instance refusée (verrou noyau exclusif)')
  second.release() // no-op : n’a jamais détenu
  lock.release()
  assert.equal(lock.db, null, 'libéré')
  assert.ok(fs.existsSync(lockPath), 'le fichier de verrou est conservé (jamais supprimé)')
  assert.equal(readOwnerPid(lockPath), null, 'plus de trace propriétaire')
  lock.release() // idempotent
  const other = new CorpusLock(lockPath)
  assert.equal(other.acquire(), true)
  other.release()
})

test('seconde instance du même process refusée ; sa fermeture perdante ne libère pas le premier (concurrent tiers)', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const first = new CorpusLock(lockPath)
  assert.equal(first.acquire(), true)
  const loser = new CorpusLock(lockPath)
  assert.equal(loser.acquire(), false, 'seconde instance même process refusée')
  loser.release() // fermeture perdante : aucun effet
  // Un concurrent TIERS constate que le premier détient toujours le verrou.
  const third = spawnChild()
  await third.waitAny(['ready'])
  third.send('acquire')
  assert.equal((await third.waitAny(['acquired', 'refused', 'error'])).type, 'refused', 'le tiers est refusé après fermeture du perdant')
  first.release()
  third.send('acquire')
  assert.equal((await third.waitAny(['acquired', 'refused', 'error'])).type, 'acquired', 'le tiers acquiert après la vraie libération')
  third.send('release')
  await third.waitAny(['released'])
  third.send('exit'); await third.exit
})

test('échec d’init ou de COMMIT : refus, aucune connexion conservée, état conservateur (artefact ambigu refusé ensuite)', { timeout: 20000 }, async (t) => {
  for (const env of [{ LOCK_FAIL_INIT: '1' }, { LOCK_FAIL_COMMIT: '1' }]) {
    const { lockPath, spawnChild } = ctx(t)
    const kid = spawnChild(env)
    await kid.waitAny(['ready'])
    kid.send('acquire')
    const r = await kid.waitAny(['acquired', 'refused', 'error'])
    assert.equal(r.type, 'refused', `échec ${JSON.stringify(env)} → refus`)
    assert.equal(r.held, false, 'aucune connexion conservée après l’échec')
    kid.send('exit'); await kid.exit
    // L’artefact laissé par l’init incomplet est ambigu : refus conservateur, pas de remplissage.
    assert.ok(fs.existsSync(lockPath), 'l’artefact de l’init échouée subsiste (conservateur)')
    assert.equal(new CorpusLock(lockPath).acquire(), false, 'artefact d’init incomplète refusé conservativement')
    removeLockArtifacts(lockPath)
    const ok = new CorpusLock(lockPath)
    assert.equal(ok.acquire(), true, 'après retrait opérateur, un verrou neuf est utilisable')
    ok.release()
  }
})

test('entrelacement de libération (barrière AVANT release) : refus tant que le verrou noyau est tenu, acquisition après', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const first = spawnChild({ LOCK_DEFER_RELEASE: '1' })
  await first.waitAny(['ready'])
  first.send('acquire')
  assert.equal((await first.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  const second = spawnChild()
  second.send('acquire')
  assert.equal((await second.waitAny(['acquired', 'refused', 'error'])).type, 'refused', 'refus tant que le verrou est tenu')
  first.send('release')
  assert.equal((await first.waitAny(['before-release', 'released', 'error'])).type, 'before-release')
  const late = spawnChild()
  late.send('acquire')
  assert.equal((await late.waitAny(['acquired', 'refused', 'error'])).type, 'refused', 'refus dans la fenêtre avant libération')
  first.resume()
  assert.equal((await first.waitAny(['released', 'error'])).type, 'released')
  second.send('acquire')
  assert.equal((await second.waitAny(['acquired', 'refused', 'error'])).type, 'acquired', 'acquisition après libération')
  second.send('release'); await second.waitAny(['released'])
  second.send('exit'); await second.exit
  first.send('exit'); await first.exit
  late.send('exit'); await late.exit
})

test('entrelacement de libération (barrière APRÈS DELETE, AVANT close) : le concurrent refuse malgré la trace effacée', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const first = spawnChild({ LOCK_PAUSE_CLOSE: '1' })
  await first.waitAny(['ready'])
  first.send('acquire')
  assert.equal((await first.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  const second = spawnChild()
  second.send('acquire')
  assert.equal((await second.waitAny(['acquired', 'refused', 'error'])).type, 'refused', 'refus tant que le verrou est tenu')
  first.send('release')
  // Barrière : DELETE de la trace COMMITÉ, connexion (verrou noyau) encore ouverte.
  assert.equal((await first.waitAny(['after-delete-before-close', 'released', 'error'])).type, 'after-delete-before-close')
  const late = spawnChild()
  late.send('acquire')
  assert.equal((await late.waitAny(['acquired', 'refused', 'error'])).type, 'refused', 'refus malgré la trace effacée (verrou noyau encore tenu)')
  first.resume()
  assert.equal((await first.waitAny(['released', 'error'])).type, 'released')
  // Après la fermeture : trace effacée (DELETE déjà commité) → état LIBRE légitime.
  assert.equal(readOwnerPid(lockPath), null, 'trace effacée : état libre après COMMIT du DELETE')
  second.send('acquire')
  assert.equal((await second.waitAny(['acquired', 'refused', 'error'])).type, 'acquired', 'acquisition après libération complète')
  second.send('release'); await second.waitAny(['released'])
  second.send('exit'); await second.exit
  first.send('exit'); await first.exit
  late.send('exit'); await late.exit
})

test('ingestion concurrente : refus explicite sans mutation du corpus', { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-lock-ing-'))
  const root = path.join(dir, 'corpus')
  const source = path.join(dir, 'source.db')
  const children = []
  const prevPiDir = process.env.SESSION_DIG_PI_DIR
  process.env.SESSION_DIG_PI_DIR = path.join(dir, 'pi-absente')
  t.after(async () => {
    if (prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
    else process.env.SESSION_DIG_PI_DIR = prevPiDir
    await killAndWait(children)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  buildFixtureDb(source)
  const first = await ingest({ root, db: source })
  const statePath = path.join(root, 'state.json')
  const markerPath = path.join(root, '.ingest-in-progress')
  const before = fs.readFileSync(statePath, 'utf8')
  const holder = new Child({ LOCK_PATH: path.join(root, '.ingest-lock') })
  children.push(holder)
  await holder.waitAny(['ready'])
  holder.send('acquire')
  assert.equal((await holder.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  await assert.rejects(ingest({ root, db: source }), /déjà en cours/, 'le concurrent échoue explicitement')
  assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'state.json inchangé par le concurrent')
  assert.ok(!fs.existsSync(markerPath), 'aucun marqueur d’ingestion posé par le concurrent')
  holder.send('release')
  await holder.waitAny(['released'])
  holder.send('exit')
  await holder.exit
  const again = await ingest({ root, db: source })
  assert.equal(again.totals.events, first.totals.events, 'après libération, la passe reprend normalement')
})
