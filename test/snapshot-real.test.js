// A4 : publication réelle pendant les commandes CLI et rebuild sans sources.
// Fixtures uniquement ; barrières IPC, aucun délai de synchronisation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { ingest, loadCorpus } from '../src/corpus.js'
import { buildView } from '../src/view.js'
import { buildFixtureDb, T0 } from './helpers/fixture.js'
import { fakeUuid, sessionLine, messageLine, infoLine, writePiSession, T0 as T0PI } from './helpers/pi-fixture.js'

const CLI = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
const READER = fileURLToPath(new URL('./helpers/snapshot-child.js', import.meta.url))
const WRITER = fileURLToPath(new URL('./helpers/crash-child.js', import.meta.url))
const WAIT_MS = 20000

class Child {
  constructor (helper, env) {
    this.msgs = []
    this.waiters = []
    this.exited = null
    this.stdout = ''
    this.stderr = ''
    const childEnv = { ...process.env, ...env }
    delete childEnv.NODE_OPTIONS
    this.proc = fork(helper, [], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
    this.proc.stdout.on('data', d => { this.stdout += d })
    this.proc.stderr.on('data', d => { this.stderr += d })
    this.proc.on('message', m => {
      const i = this.waiters.findIndex(w => w.types.includes(m.type))
      if (i < 0) this.msgs.push(m)
      else {
        const w = this.waiters.splice(i, 1)[0]
        clearTimeout(w.timer)
        w.resolve(m)
      }
    })
    this.exit = new Promise((resolve, reject) => {
      this.proc.once('error', reject)
      this.proc.once('exit', (code, signal) => { this.exited = { code, signal } })
      // close : stdout/stderr drainés, pas seulement la sortie du processus.
      this.proc.once('close', (code, signal) => resolve({ code, signal }))
    })
  }
  wait (types) {
    const i = this.msgs.findIndex(m => types.includes(m.type))
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { types, resolve, timer: null }
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        reject(new Error(`barrière A4 absente : ${types.join('/')} ; stderr=${this.stderr}`))
      }, WAIT_MS)
      this.waiters.push(w)
    })
  }
  resume () { this.proc.stdin.write(Buffer.from([1])) }
  send (cmd) { this.proc.send({ cmd }) }
  kill () { if (!this.exited) this.proc.kill('SIGKILL') }
  async finish (ms = WAIT_MS) {
    let timer
    try {
      return await Promise.race([this.exit, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`enfant A4 ${this.proc.pid} non terminé`)), ms)
      })])
    } finally { clearTimeout(timer) }
  }
}

async function fixture (t, mixed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-a4-'))
  const root = path.join(dir, 'corpus')
  const source = path.join(dir, 'source.db')
  const piDir = path.join(dir, 'pi')
  const children = []
  t.after(async () => {
    for (const c of children) c.kill()
    // Une deadline échouée laisse le répertoire intact, jamais de rm sous enfant vivant.
    await Promise.all(children.map(c => c.finish(5000)))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  buildFixtureDb(source)
  const uuid = fakeUuid()
  const piFile = path.join(piDir, 'proj', 'session.jsonl')
  const addPiBase = () => writePiSession(piDir, 'proj', 'session.jsonl', [
    sessionLine(uuid, T0PI, '/synthetic/a4'),
    infoLine(T0PI + 1, 'Pi génération A', 'a4_info'),
    messageLine(T0PI + 1000, { role: 'user', content: [{ type: 'text', text: 'proxy pi génération A' }] }, 'a4_user')
  ])
  if (mixed) addPiBase()
  const opts = () => ({ root, db: source, piDir, source: fs.existsSync(piDir) ? 'all' : 'opencode' })
  await ingest(opts())
  const env = { SESSION_DIG_HOME: root, SESSION_DIG_DB: source, SESSION_DIG_PI_DIR: piDir }
  const readArgs = ['read', 'ses_fix1', '--around', 'msg_a1', '--ctx', '1', '--at', 'msg_a2', '--json', '--home', root]
  const searchArgs = ['proxy', '--ctx', '1', '--plain', '--home', root]
  const run = args => {
    const e = { ...process.env, ...env }
    delete e.NODE_OPTIONS
    const r = spawnSync(process.execPath, [CLI, ...args], { env: e, encoding: 'utf8', timeout: WAIT_MS })
    assert.equal(r.status, 0, r.stderr || String(r.error))
    return r.stdout
  }
  const delta = () => {
    const db = new Database(source)
    try {
      const td = T0 + 250_000_000
      db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?')
        .run(JSON.stringify({ type: 'text', text: 'proxy génération B generationbunique' }), td, 'prt_u1')
      db.prepare('UPDATE message SET time_updated = ? WHERE id = ?').run(td, 'msg_u1')
      db.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?')
        .run('Opencode génération B', td, 'ses_fix1')
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
        .run('a4_added', 'ses_fix1', td + 1, td + 1, JSON.stringify({ role: 'user' }))
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
        .run('a4_part', 'a4_added', 'ses_fix1', td + 1, td + 1, JSON.stringify({ type: 'text', text: 'proxy nouveau message génération B' }))
    } finally { db.close() }
    if (fs.existsSync(piFile)) fs.appendFileSync(piFile,
      infoLine(T0PI + 2000, 'Pi génération B', 'a4_info_b') + '\n' +
      messageLine(T0PI + 3000, { role: 'user', content: [{ type: 'text', text: 'proxy pi génération B' }] }, 'a4_added_pi') + '\n')
  }
  const spawn = (helper, extra) => {
    const c = new Child(helper, { ...env, ...extra })
    children.push(c)
    return c
  }
  return { dir, root, source, piDir, mixed, opts, run, readArgs, searchArgs, delta, addPiBase,
    reader: (point, args) => spawn(READER, { SNAPSHOT_POINT: point, SNAPSHOT_ARGS: JSON.stringify(args) }),
    writer: () => spawn(WRITER, { CRASH_ROOT: root, CRASH_DB: source,
      ...(fs.existsSync(piDir) ? { CRASH_PI: piDir } : {}),
      CRASH_FN: 'writeFileSync', CRASH_MATCH: 'state.json.tmp-' }) }
}

for (const mixed of [false, true]) {
  const family = mixed ? 'mixte' : 'opencode'
  for (const kind of ['search', 'read']) {
    test(`A4 ${family} ${kind} : publier un vrai delta après la première donnée conserve toute la génération A`, { timeout: 40000 }, async t => {
      const f = await fixture(t, mixed)
      const args = kind === 'read' ? f.readArgs : f.searchArgs
      const before = f.run(args)
      const c = f.reader(kind === 'read' ? 'after-meta' : 'after-hits', args)
      await c.wait(['paused'])
      f.delta()
      const published = await ingest(f.opts())
      assert.equal(published.added, mixed ? 2 : 1, 'la publication concurrente contient un delta réel')
      const after = f.run(args)
      assert.notEqual(after, before, 'générations réellement discriminantes : texte/titre/comptes changés')
      c.resume()
      const result = await c.finish()
      assert.equal(result.code, 0, c.stderr)
      assert.equal(c.stdout, before, 'hits/voisins/comptes/métadonnées : exclusivement la génération A')
    })
  }
}

for (const family of ['opencode', 'mixte', 'premier-pi']) {
  test(`A4 ${family} : ouverture avant BEGIN, publication après COMMIT avant état`, { timeout: 40000 }, async t => {
    const f = await fixture(t, family === 'mixte')
    const c = f.reader('before-begin', f.readArgs)
    await c.wait(['paused']) // openView a validé A, mais aucune transaction n'a commencé
    if (family === 'premier-pi') f.addPiBase()
    f.delta()
    const writer = f.writer()
    await writer.wait(['ready'])
    writer.send('run')
    await writer.wait(['paused']) // vrai COMMIT B ; state.json reste A
    c.resume()
    const read = await c.finish()
    if (family === 'opencode') {
      assert.equal(read.code, 0, c.stderr)
      assert.doesNotThrow(() => JSON.parse(c.stdout), 'opencode en avance reste lisible')
    } else {
      assert.notEqual(read.code, 0, 'la vue fusionnée doit refuser le jeton Pi divergent/absent')
      assert.equal(c.stdout, '', 'aucun résultat partiel présenté comme réussi')
      assert.match(c.stderr, /jeton/, 'motif de fraîcheur explicite')
    }
    writer.resume()
    const done = await writer.wait(['done', 'error'])
    assert.equal(done.type, 'done', done.message)
    writer.send('exit')
    assert.equal((await writer.finish()).code, 0)
    const final = f.run(f.readArgs)
    if (family === 'opencode') assert.deepEqual(JSON.parse(c.stdout), JSON.parse(final), 'lecture réussie = génération B complète')
  })
}

function archiveBytes (root) {
  const files = new Map()
  function walk (dir, prefix = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const file = path.join(dir, e.name)
      if (e.isDirectory()) walk(file, rel)
      else if (!rel.startsWith('index.db') && rel !== '.ingest-lock') files.set(rel, fs.readFileSync(file))
    }
  }
  walk(root)
  return [...files].sort(([a], [b]) => a.localeCompare(b))
}

for (const mixed of [false, true]) {
  test(`A4 rebuild autonome ${mixed ? 'mixte' : 'opencode'} : sources indisponibles, archive inchangée, résultats et comptes conservés`, async t => {
    const f = await fixture(t, mixed)
    f.delta()
    await ingest(f.opts())
    const beforeView = loadCorpus(f.root)
    const beforeArchive = archiveBytes(f.root)
    const beforeRead = f.run(f.readArgs)
    const searchArgs = ['generationbunique', '--ctx', '1', '--plain', '--home', f.root]
    const beforeSearch = f.run(searchArgs)
    fs.renameSync(f.source, `${f.source}.absente`)
    if (mixed) fs.renameSync(f.piDir, `${f.piDir}.absente`)
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(f.root, `index.db${suffix}`), { force: true })
    // Garde JS en plus de l'indisponibilité effective des sources (open natif
    // readonly/fileMustExist échouerait aussi sur ces chemins désormais absents).
    const originals = new Map()
    const sourceAccess = []
    for (const name of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'readdirSync']) {
      const original = fs[name]
      originals.set(name, original)
      fs[name] = function (p, ...args) {
        if (typeof p === 'string' && [f.source, f.piDir].some(source => p === source || p.startsWith(source + path.sep) || p.startsWith(source + '-'))) {
          sourceAccess.push({ name, path: p })
          throw new Error(`rebuild a tenté d'accéder à une source : ${name}`)
        }
        return original.call(this, p, ...args)
      }
    }
    try { assert.equal(buildView(f.root).events, beforeView.events.length) } finally {
      for (const [name, original] of originals) fs[name] = original
    }
    assert.deepEqual(sourceAccess, [], 'aucun accès aux sources, même si une erreur était interceptée')
    assert.deepEqual(archiveBytes(f.root), beforeArchive, 'événements, métadonnées, raw et état intacts octet par octet')
    const afterView = loadCorpus(f.root)
    const byId = events => [...events].sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(byId(afterView.events), byId(beforeView.events))
    assert.deepEqual(afterView.sessions, beforeView.sessions)
    assert.equal(f.run(f.readArgs), beforeRead, 'ancre, masquage, compteurs et provenance préservés')
    assert.equal(f.run(searchArgs), beforeSearch, 'résultats, voisins et métadonnées préservés')
  })
}
