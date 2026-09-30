// Tests multi-processus ciblés du verrou consultatif (lot A1 — exclusion des
// écrivains). Fixtures synthétiques uniquement, répertoires jetables, quelques
// enfants, barrières IPC (aucune synchronisation par délai) et nettoyage
// systématique. Ces tests modélisent la section protégée par un journal partagé ;
// ils ne remplacent pas la campagne de crash/concurrence A2-A5.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CorpusLock, ingest } from '../src/corpus.js'
import { buildFixtureDb } from './helpers/fixture.js'

const HELPER = fileURLToPath(new URL('./helpers/lock-child.js', import.meta.url))
const WAIT_MS = 10000

// Enfant piloté par IPC : les messages SONT les barrières (pas de délai), et le
// dépassement de WAIT_MS est un filet de sécurité explicite, jamais une synchro.
class Child {
  constructor (env) {
    this.msgs = []
    this.waiters = []
    this.exited = null
    this.stderr = ''
    const childEnv = { ...process.env, ...env }
    delete childEnv.NODE_OPTIONS
    this.proc = fork(HELPER, [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
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

  send (cmd) { this.proc.send({ cmd }) }
  kill () { if (this.exited == null) { try { this.proc.kill('SIGKILL') } catch {} } }
}

// Nettoyage systématique : tuer UNIQUEMENT les enfants créés et ATTENDRE leur
// sortie (borne de sécurité) AVANT de retirer le répertoire — jamais de `rm`
// pendant qu'un enfant pourrait encore écrire. La borne est un filet de
// nettoyage, jamais une synchronisation de test.
async function killAndWait (children) {
  await Promise.all(children.map((c) => new Promise((resolve) => {
    c.kill()
    const timer = setTimeout(resolve, 2000)
    c.exit.then(() => { clearTimeout(timer); resolve() })
  })))
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

test('verrou vide / illisible / type inattendu : refus conservateur, fichier intact', (t) => {
  const { lockPath } = ctx(t)
  const cases = ['', '{ pas du json', '{"pid":"abc"}', '{"pid":0}', '{"at":"sans pid"}', '[]']
  for (const content of cases) {
    fs.writeFileSync(lockPath, content)
    assert.equal(new CorpusLock(lockPath).acquire(), false, `contenu ${JSON.stringify(content)}`)
    assert.equal(fs.readFileSync(lockPath, 'utf8'), content, 'fichier du verrou inchangé')
  }
  fs.rmSync(lockPath, { force: true })
  fs.mkdirSync(lockPath)
  assert.equal(new CorpusLock(lockPath).acquire(), false, 'répertoire au chemin du verrou')
  assert.ok(fs.statSync(lockPath).isDirectory(), 'répertoire intact')
})

test('propriétaire vivant (enfant réel) : refus, verrou intact, reprise après release', { timeout: 20000 }, async (t) => {
  const { lockPath, logPath, spawnChild } = ctx(t)
  const owner = spawnChild()
  await owner.waitAny(['ready'])
  owner.send('acquire')
  assert.equal((await owner.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')
  const mine = new CorpusLock(lockPath)
  assert.equal(mine.acquire(), false, 'un propriétaire vivant ne peut pas être dépassé')
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, owner.pid)
  assert.equal(fs.readFileSync(logPath, 'utf8').trim(), `BEGIN ${owner.pid}`)
  owner.send('release')
  assert.equal((await owner.waitAny(['released'])).type, 'released')
  owner.send('exit')
  await owner.exit
  assert.equal(mine.acquire(), true, 'après release, le verrou est libre')
  mine.release()
  assert.ok(!fs.existsSync(lockPath))
})

test('propriétaire mort (sortie enfant observée) : refus conservateur, aucun retrait automatique', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const owner = spawnChild()
  await owner.waitAny(['ready'])
  owner.send('acquire')
  await owner.waitAny(['acquired'])
  owner.send('abandon')
  const ex = await owner.exit
  assert.equal(ex.code, 7, 'sortie brutale réellement observée')
  assert.ok(fs.existsSync(lockPath), 'verrou laissé en place par le propriétaire mort')
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, owner.pid)
  const contender = new CorpusLock(lockPath)
  assert.equal(contender.acquire(), false, 'pas de reprise automatique d’un verrou de propriétaire mort')
  assert.ok(fs.existsSync(lockPath), 'le concurrent n’a pas retiré le verrou')
})

test('deux repreneurs sur verrou périmé : les deux refusent, le fichier reste intact', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  // PID réellement mort : un enfant dont la SORTIE a été observée.
  const dead = spawnChild()
  await dead.waitAny(['ready'])
  dead.send('exit')
  await dead.exit
  const deadPid = dead.pid
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, at: new Date(0).toISOString() }) + '\n')
  const before = fs.readFileSync(lockPath, 'utf8')
  const a = spawnChild(); const b = spawnChild()
  await Promise.all([a.waitAny(['ready']), b.waitAny(['ready'])])
  a.send('acquire'); b.send('acquire')
  const [ra, rb] = await Promise.all([
    a.waitAny(['acquired', 'refused', 'error']),
    b.waitAny(['acquired', 'refused', 'error'])
  ])
  assert.deepEqual([ra.type, rb.type], ['refused', 'refused'], 'aucun des deux repreneurs ne prend un verrou ambigu')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'aucun repreneur n’a touché le verrou')
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
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, winner.pid)
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

test('acquire idempotent sur la même instance ; release n’efface pas le verrou d’un autre', (t) => {
  const { lockPath } = ctx(t)
  const lock = new CorpusLock(lockPath)
  assert.equal(lock.acquire(), true)
  const fd = lock.fd
  assert.equal(lock.acquire(), true, 'seconde acquisition : déjà détenu')
  assert.equal(lock.fd, fd, 'le descripteur détenu est conservé')
  lock.release()
  assert.ok(!fs.existsSync(lockPath), 'release retire notre verrou')
  lock.release() // idempotent, sans effet
  assert.equal(lock.acquire(), true)
  // Retrait externe puis installation d'un AUTRE propriétaire : notre release ne
  // doit pas supprimer son fichier (comparaison dev/ino avec le descripteur détenu).
  fs.rmSync(lockPath, { force: true })
  const other = JSON.stringify({ pid: 424242, at: new Date(0).toISOString() }) + '\n'
  fs.writeFileSync(lockPath, other)
  lock.release()
  assert.ok(fs.existsSync(lockPath), 'le verrou d’un autre propriétaire est préservé')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), other)
})

test('échec d’écriture après création : verrou nettoyé, aucun descripteur orphelin', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  const kid = spawnChild({ LOCK_FAIL_WRITE: '1' })
  await kid.waitAny(['ready'])
  kid.send('acquire')
  const r = await kid.waitAny(['acquired', 'refused', 'error'])
  assert.equal(r.type, 'error')
  assert.equal(r.code, 'EIO')
  assert.ok(!fs.existsSync(lockPath), 'le verrou créé puis en échec est nettoyé')
  kid.send('exit')
  await kid.exit
  const lock = new CorpusLock(lockPath)
  assert.equal(lock.acquire(), true, 'le verrou reste utilisable après le nettoyage')
  lock.release()
})

test('ingestion concurrente : refus explicite sans mutation du corpus', { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-lock-ing-'))
  const root = path.join(dir, 'corpus')
  const source = path.join(dir, 'source.db')
  const children = []
  const prevPiDir = process.env.SESSION_DIG_PI_DIR
  process.env.SESSION_DIG_PI_DIR = path.join(dir, 'pi-absente') // source pi hermétique : jamais ~/.pi réel
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
  // Un AUTRE processus détient le verrou réel du corpus.
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

test('entrelacement contrôlé du release : refus sous verrou, puis préservation du nouveau propriétaire', { timeout: 20000 }, async (t) => {
  const { lockPath, spawnChild } = ctx(t)
  // Le premier propriétaire diffère son unlink : la barrière est IPC, sans délai.
  const first = spawnChild({ LOCK_DEFER_UNLINK: '1' })
  await first.waitAny(['ready'])
  first.send('acquire')
  assert.equal((await first.waitAny(['acquired', 'refused', 'error'])).type, 'acquired')

  // Tant que le verrou est conservé, un concurrent est refusé (déterministe :
  // l'acquisition est tentée après confirmation explicite de la détention).
  const second = spawnChild()
  second.send('acquire')
  assert.equal((await second.waitAny(['acquired', 'refused', 'error'])).type, 'refused', 'refus tant que le verrou est conservé')
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, first.pid)

  // Release du premier : barrière IPC juste AVANT l'unlink (fichier encore présent).
  first.send('release')
  assert.equal((await first.waitAny(['unlink-deferred', 'released', 'error'])).type, 'unlink-deferred')
  assert.ok(fs.existsSync(lockPath), 'fichier encore présent à la barrière avant unlink')
  // Un concurrent tente précisément dans cette fenêtre : refus (fichier conservé).
  const late = spawnChild()
  late.send('acquire')
  assert.equal((await late.waitAny(['acquired', 'refused', 'error'])).type, 'refused', 'refus dans la fenêtre avant unlink')

  // Fin du release (unlink effectif) → le concurrent peut acquérir.
  first.send('finish-release')
  assert.equal((await first.waitAny(['released', 'error'])).type, 'released')
  second.send('acquire')
  assert.equal((await second.waitAny(['acquired', 'refused', 'error'])).type, 'acquired', 'acquisition après release terminé')
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, second.pid)

  // Ré-exécuter le release de l'ANCIEN propriétaire (fd déjà nul → no-op) ne doit
  // pas retirer le verrou du nouveau propriétaire.
  first.send('release')
  assert.equal((await first.waitAny(['unlink-deferred', 'released', 'error'])).type, 'released', 'aucun unlink différé rejoué')
  assert.ok(fs.existsSync(lockPath), 'le verrou du nouveau propriétaire est préservé')
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, second.pid)

  second.send('release')
  await second.waitAny(['released'])
  second.send('exit'); await second.exit
  first.send('exit'); await first.exit
  late.send('exit'); await late.exit
})
