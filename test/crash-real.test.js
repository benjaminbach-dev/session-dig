// Lot A3 — interruptions RÉELLES aux points exacts du protocole de publication
// (change scale-corpus, tasks.md lot A3). Chaque scénario : un enfant exécute une
// ingestion et se met en PAUSE à un point EXACT du protocole (hook fs ou
// Database.prototype.exec installé ENFANT UNIQUEMENT — test/helpers/crash-child.js,
// aucune API de test en production) ; le parent SIGKILL à la réception de 'paused',
// attend la sortie OBSERVÉE, puis vérifie l'état interrompu : verrou conservé
// (refus conservateur tant que le verrou périmé est présent), marqueur détecteur,
// lectures cohérentes ou refus explicite, archive refusée, avertissement preuves.
// La relance (avec sources) puis la passe sans changement convergent vers le
// contenu canonique — obtenu par ingestion PROPRE en corpus séparé, mêmes sources
// aux chemins inchangés. Reprise du verrou : retrait OPÉRATEUR simulé UNIQUEMENT
// après arrêt coordonné (sortie observée, PID victime confirmé mort, aucun
// sous-processus possible — le helper n'en crée pas).
//
// Deux familles : opencode seul, et corpus mixte avec Pi (fixtures synthétiques ;
// source pi explicitement sous le tmp du test — jamais ~/.pi). Delta : 2 shards de
// session + métadonnées modifiées + preuve brute nouvelle ET changée par famille,
// timestamps stables à id égal, watermark du delta très au-delà du max de la
// fixture (T0+173 M). Aucune promesse de résistance à une panne matérielle : ces
// tests interrompent le processus, ils ne fabriquent pas de panne disque.
import { test, after } from 'node:test'

// add-pi-adapter : restauration de l'environnement hermétique (indépendance du runner)
after(() => {
  if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = __prevPiDir
})
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import Database from 'better-sqlite3'
import { buildFixtureDb, T0 } from './helpers/fixture.js'
import {
  T0 as T0PI, fakeUuid, sessionLine, messageLine, infoLine, writePiSession
} from './helpers/pi-fixture.js'
import { ingest, recover, fingerprint, ingestRunning, proofWarning, loadCorpus } from '../src/corpus.js'
import { listShards, rawShardPath } from '../src/layout.js'
import { openView, checkFresh } from '../src/view.js'
import { readJsonl } from '../src/util.js'

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-a3-'))
// ⚠ hermétique : chemin pi « par défaut » ABSENT — la source pi n'est utilisée que
// via CRASH_PI/piDir explicites dans les scénarios mixtes ; jamais ~/.pi.
const __prevPiDir = process.env.SESSION_DIG_PI_DIR
process.env.SESSION_DIG_PI_DIR = path.join(tmpBase, 'pi-par-defaut-inexistante')
after(() => fs.rmSync(tmpBase, { recursive: true, force: true }))

const CRASH_HELPER = fileURLToPath(new URL('./helpers/crash-child.js', import.meta.url))
const WAIT_MS = 15000
const KILL_MS = 5000
const TD = T0 + 250_000_000 // delta : très au-delà du max de la fixture (T0+173 M)

// ── Enfant piloté par IPC : les messages SONT les barrières ──
class CrashChild {
  constructor (env) {
    this.msgs = []
    this.waiters = []
    this.exited = null
    this.stderr = ''
    const childEnv = { ...process.env, ...env }
    delete childEnv.NODE_OPTIONS
    this.proc = fork(CRASH_HELPER, [], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
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
  send (cmd) { this.proc.send({ cmd }) }
  kill () { if (this.exited == null) { try { this.proc.kill('SIGKILL') } catch {} } }

  _deliver (m) {
    const i = this.waiters.findIndex((w) => w.types.includes(m.type))
    if (i >= 0) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m) }
    else this.msgs.push(m)
  }

  waitAny (types, ms = WAIT_MS) {
    const i = this.msgs.findIndex((m) => types.includes(m.type))
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { types, resolve, timer: null }
      w.timer = setTimeout(() => {
        const j = this.waiters.indexOf(w)
        if (j >= 0) this.waiters.splice(j, 1)
        reject(new Error(`timeout ${ms} ms en attente de [${types.join('|')}] — stderr enfant : ${this.stderr || '(vide)'}`))
      }, ms)
      this.waiters.push(w)
    })
  }
}

// ── Delta de la source opencode : 2 shards de session (ses_fix1, ses_fix2),
// métadonnées (time_updated des sessions), preuve brute CHANGÉE (prt_a1tool) et
// NOUVELLE (prt_d1tool). Timestamps stables à id égal ; watermark dépassée. ──
function applyOcDelta (dbPath) {
  const db = new Database(dbPath)
  db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = 'prt_u1'")
    .run(JSON.stringify({ type: 'text', text: 'MODIFIÉ A3 : le proxy renvoie désormais 462, pas seulement 461' }), TD)
  db.prepare("UPDATE message SET time_updated = ? WHERE id = 'msg_u1'").run(TD)
  db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = 'prt_a1tool'")
    .run(JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'git revert abc123' }, output: 'revert ok — preuve brute CHANGÉE A3\n', metadata: { exitCode: 0 } } }), TD)
  db.prepare("UPDATE message SET time_updated = ? WHERE id = 'msg_a1'").run(TD)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    .run('msg_d1', 'ses_fix2', TD + 10, TD + 10, JSON.stringify({ role: 'assistant', agent: 'build', model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' } }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
    .run('prt_d1t', 'msg_d1', 'ses_fix2', TD + 10, TD + 10, JSON.stringify({ type: 'text', text: 'delta A3 : nouveau message opencode avec preuve' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
    .run('prt_d1tool', 'msg_d1', 'ses_fix2', TD + 10, TD + 10,
      JSON.stringify({ type: 'tool', tool: 'bash', callID: 'cd1', state: { status: 'completed', input: { command: 'git status' }, output: 'sur branch main — preuve brute NOUVELLE A3\n', metadata: { exitCode: 0 } } }))
  db.prepare("UPDATE session SET time_updated = ? WHERE id IN ('ses_fix1','ses_fix2')").run(TD)
  db.close()
}

// ── Delta de la source pi (famille mixte) : réécriture du MÊME fichier, mêmes ids
// de lignes, timestamps stables (D2) ; toolResult c1 changé → preuve brute CHANGÉE,
// appends (info + nouvel appel c2 et son résultat) → métadonnées + preuve NOUVELLE. ──
const text = (s) => ({ type: 'text', text: s })
const toolCallP = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })

let piUuid = null
function buildPiBase (piDir) {
  piUuid = fakeUuid()
  writePiSession(piDir, 'proj-a', 'ses_a.jsonl', [
    sessionLine(piUuid, T0PI, '/root/proj-a'),
    infoLine(T0PI + 10, 'Session pi de base A3', 'infa'),
    messageLine(T0PI + 1000, { role: 'user', content: [text('question pi A3 de base')], timestamp: T0PI + 100 }, 'lbase1'),
    messageLine(T0PI + 2000, { role: 'assistant', content: [text('réponse pi de base'), toolCallP('c1', 'bash', { command: 'cat proxy.json' })], provider: 'antho', model: 'sonnet-x', timestamp: T0PI + 1500 }, 'lbase2'),
    messageLine(T0PI + 3000, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [text('timeout: 30\n')], timestamp: T0PI + 2500 }, 'lbase3')
  ])
}

function applyPiDelta (piDir) {
  const baseUser = { role: 'user', content: [text('question pi A3 de base')], timestamp: T0PI + 100 }
  const baseAsst = { role: 'assistant', content: [text('réponse pi de base'), toolCallP('c1', 'bash', { command: 'cat proxy.json' })], provider: 'antho', model: 'sonnet-x', timestamp: T0PI + 1500 }
  writePiSession(piDir, 'proj-a', 'ses_a.jsonl', [
    sessionLine(piUuid, T0PI, '/root/proj-a'),
    infoLine(T0PI + 10, 'Session pi A3 delta', 'infa'),
    messageLine(T0PI + 1000, baseUser, 'lbase1'),
    messageLine(T0PI + 2000, baseAsst, 'lbase2'),
    // même id de ligne (lbase3), même ts, contenu changé → preuve brute CHANGÉE
    messageLine(T0PI + 3000, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [text('timeout: 45 — preuve brute CHANGÉE A3\n')], timestamp: T0PI + 2500 }, 'lbase3'),
    infoLine(T0PI + 4000, 'Session pi A3 delta — nom final', 'infd'),
    messageLine(T0PI + 5000, { role: 'assistant', content: [text('delta pi : nouvel appel'), toolCallP('c2', 'bash', { command: 'git log -1' })], provider: 'antho', model: 'sonnet-x', timestamp: T0PI + 4500 }, 'ldelta1'),
    messageLine(T0PI + 6000, { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [text('commit abc — preuve brute NOUVELLE pi A3\n')], timestamp: T0PI + 5500 }, 'ldelta2')
  ])
}

// ── Inspecteurs ──
const sortEvents = (evs) => [...evs].sort((a, b) =>
  a.sessionId !== b.sessionId ? (a.sessionId < b.sessionId ? -1 : 1)
    : a.ts !== b.ts ? a.ts - b.ts : (a.id < b.id ? -1 : 1))

function shardEvents (root) {
  const out = []
  for (const rel of listShards(root)) out.push(...readJsonl(path.join(root, rel)))
  return sortEvents(out)
}

const isTemp = (name) => name.includes('.new-') || name.endsWith('.new') || name.includes('.tmp-')

function tempsInventory (root) {
  const out = []
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, r)
      else if (isTemp(e.name)) out.push(r)
    }
  }
  walk(root, '')
  return out.sort()
}

// Octets PUBLIÉS : shards d'événements + sessions.jsonl + raw/** (hors temporaires).
// Hors état/marqueur/verrou/vue : la vue et l'état ont leurs propres vérifications.
function publishedSnapshot (root) {
  const out = new Map()
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, r)
      else if (!isTemp(e.name)) out.set(r, fs.readFileSync(p))
    }
  }
  for (const top of ['events', 'raw']) walk(path.join(root, top), top)
  const ses = path.join(root, 'sessions.jsonl')
  if (fs.existsSync(ses)) out.set('sessions.jsonl', fs.readFileSync(ses))
  return out
}

// Contenu canonique comparé : événements (shards), métadonnées, preuves brutes,
// compteurs de l'état — PAS les octets de state.json (updatedAt/jetons volatils).
function corpusContent (root) {
  const raw = {}
  const walkRaw = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const p = path.join(d, e.name)
      if (e.isDirectory()) walkRaw(p, r)
      else if (!isTemp(e.name)) raw[r] = fs.readFileSync(p, 'utf8')
    }
  }
  walkRaw(path.join(root, 'raw'), '')
  const st = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  return {
    events: shardEvents(root),
    sessions: readJsonl(path.join(root, 'sessions.jsonl')).sort((a, b) => (a.id < b.id ? -1 : 1)),
    raw,
    counts: st.counts
  }
}

function assertCorpusEqual (got, want, msg) {
  assert.deepEqual(got.counts, want.counts, `${msg} — compteurs exacts`)
  assert.deepEqual(got.events, want.events, `${msg} — événements identiques`)
  assert.deepEqual(got.sessions, want.sessions, `${msg} — métadonnées identiques`)
  assert.deepEqual(got.raw, want.raw, `${msg} — preuves brutes identiques`)
}

// Vue == archive sur disque (la vue est bien reconstruite depuis le corpus tel qu'il est).
function assertViewEqualsArchive (root) {
  const lc = loadCorpus(root)
  assert.deepEqual(sortEvents(lc.events), shardEvents(root), 'vue == archive sur disque (événements)')
  assert.deepEqual(lc.sessions, readJsonl(path.join(root, 'sessions.jsonl')).sort((a, b) => (a.id < b.id ? -1 : 1)),
    'vue == archive sur disque (métadonnées)')
}

// ── Reprise du verrou par l'OPÉRATEUR de test, UNIQUEMENT après arrêt coordonné ──
function reclaimLock (root, victimPid, label) {
  const lockPath = path.join(root, '.ingest-lock')
  const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  assert.equal(info.pid, victimPid, `${label} — le verrou portait bien le PID de la victime`)
  let alive = null
  try { process.kill(victimPid, 0); alive = true } catch (e) { alive = e.code === 'ESRCH' ? false : null }
  assert.equal(alive, false, `${label} — propriétaire mort (sortie observée avant retrait)`)
  // Le helper crash-child ne crée aucun sous-processus (aucun fork en lui) : aucun
  // enfant actif possible du propriétaire — retrait coordonné légitime, action de
  // TEST uniquement (le mécanisme de production ne change pas).
  fs.rmSync(lockPath)
}

// ── Points d'interruption (protocole : marqueur → staging → renames → COMMIT →
//       state.json → retrait du marqueur) ──
const POINTS = {
  'avant-staging': { hook: { fn: 'writeFileSync', match: '.ingest-in-progress' }, label: "avant la pose du marqueur — rien n'a pu commencer" },
  'pendant-staging': { hook: { fn: 'renameSync', match: '.new-' }, label: 'staging entamé (.new- écrits), avant le premier rename' },
  'entre-renames': { hook: { fn: 'renameSync', match: 'sessions.jsonl.new-' }, label: 'renames de shards faits, rename des métadonnées en attente' },
  'dernier-rename-avant-COMMIT': { hook: { dbExec: 'COMMIT' }, label: 'tous les renames faits, COMMIT de la vue pas exécuté' },
  'post-COMMIT-avant-état': { hook: { fn: 'writeFileSync', match: '.tmp-' }, label: 'vue COMMITée, state.json pas encore écrit' },
  'post-état-avant-retrait-marqueur': { hook: { fn: 'rmSync', match: '.ingest-in-progress' }, label: 'state.json écrit, marqueur pas encore retiré' },
  'state-tmp-écrit-avant-rename': { hook: { fn: 'renameSync', match: '.tmp-' }, label: 'state.json.tmp- écrit, rename pas exécuté (fuite de temporaires)' }
}

// Points d'où le COMMIT a déjà eu lieu : la relance ré-applique le delta
// idempotemment (added = 0) ; avant COMMIT, la relance ajoute le delta complet
// (compteurs = passe propre de référence).
const POST_COMMIT = new Set(['post-COMMIT-avant-état', 'post-état-avant-retrait-marqueur', 'state-tmp-écrit-avant-rename'])

const ocOpts = (root, dbPath, piDir) => ({ root, db: dbPath, ...(piDir ? { piDir } : {}) })

async function runCrashScenario (t, { family, point, mode = 'relance' }) {
  const P = POINTS[point]
  const mixte = family === 'mixte'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-a3-'))
  const children = []
  t.after(async () => {
    for (const c of children) c.kill()
    // sortie OBSERVÉE de tout enfant avant toute suppression de répertoire ;
    // la borne de sécurité REJETTE (jamais de rmSync sous un enfant vivant)
    await Promise.all(children.map((c) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`enfant ${c.pid} pas sorti ${KILL_MS} ms après le kill`)), KILL_MS)
      c.exit.then((ex) => { clearTimeout(timer); resolve(ex) })
    })))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const root = path.join(dir, 'corpus-a')
  const rootC = path.join(dir, 'corpus-canon')
  const dbPath = path.join(dir, 'source.db')
  const piDir = mixte ? path.join(dir, 'pi') : null

  buildFixtureDb(dbPath)
  if (mixte) buildPiBase(piDir)
  await ingest(ocOpts(root, dbPath, piDir))
  await ingest(ocOpts(rootC, dbPath, piDir))

  // base = dernier état proprement publié (avant delta)
  const baseEvents = shardEvents(root)
  const baseStateBytes = fs.readFileSync(path.join(root, 'state.json'))
  const basePublished = publishedSnapshot(root)

  // delta appliqué UNE fois aux sources (chemins inchangés, partagés par A et C)
  applyOcDelta(dbPath)
  if (mixte) applyPiDelta(piDir)

  // canonique : ingestion PROPRE en corpus séparé, mêmes sources aux mêmes chemins
  const cDelta = await ingest(ocOpts(rootC, dbPath, piDir))
  const canonical = corpusContent(rootC)

  // enfant : ingestion de A interrompue au point exact (SIGKILL sur 'paused')
  const kid = new CrashChild({
    CRASH_ROOT: root, CRASH_DB: dbPath, ...(piDir ? { CRASH_PI: piDir } : {}),
    ...(P.hook.fn ? { CRASH_FN: P.hook.fn, CRASH_MATCH: P.hook.match } : {}),
    ...(P.hook.dbExec ? { CRASH_DB_EXEC: P.hook.dbExec } : {})
  })
  children.push(kid)
  await kid.waitAny(['ready'])
  kid.send('run')
  const paused = await kid.waitAny(['paused'])
  assert.ok(paused.at, 'le point de pause exact est consigné')
  kid.kill()
  const ex = await kid.exit
  assert.equal(ex.signal, 'SIGKILL', `interruption réelle (${point} — ${P.label}) : SIGKILL observé au point de pause`)

  const stPath = path.join(root, 'state.json')
  const lockPath = path.join(root, '.ingest-lock')
  const stateBytesNow = () => fs.readFileSync(stPath)

  // ── état interrompu : verrou conservateur, marqueur détecteur, publication ──
  assert.ok(fs.existsSync(lockPath), `${point} — le verrou reste posé après l'arrêt brutal`)
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, kid.pid,
    `${point} — le verrou portait le PID de la victime`)
  // relance refusée tant que le verrou périmé est présent (refus conservateur)
  await assert.rejects(() => ingest(ocOpts(root, dbPath, piDir)), /verrou consultatif/,
    `${point} — relance refusée tant que le verrou périmé est présent`)
  assert.throws(() => recover(root), /verrou consultatif/,
    `${point} — recover refuse aussi le verrou périmé, sans reprise automatique`)

  const markerExpected = point !== 'avant-staging'
  assert.equal(ingestRunning(root), markerExpected,
    `${point} — marqueur ${markerExpected ? 'présent' : "absent (aucun remplacement n'a pu commencer)"}`)
  if (markerExpected) {
    assert.match(proofWarning(root), /ingestion en cours/, `${point} — avertissement preuves signalé`)
  } else {
    assert.equal(proofWarning(root), null, `${point} — aucun avertissement sans passe entamée`)
  }

  // temporaires au point d'interruption (avant la relance)
  const temps = tempsInventory(root)
  if (point === 'avant-staging') assert.deepEqual(temps, [], `${point} — aucun temporaire`)
  if (point === 'pendant-staging') assert.ok(temps.length >= 1, `${point} — au moins un .new- en staging`)
  if (point === 'entre-renames') {
    assert.ok(temps.some((r) => r.includes('sessions.jsonl.new-')), `${point} — rename des métadonnées en attente`)
  }
  if (point === 'dernier-rename-avant-COMMIT') {
    assert.deepEqual(temps, [], `${point} — plus aucun .new (l'état que seul le marqueur voit)`)
  }
  if (point === 'state-tmp-écrit-avant-rename') {
    assert.ok(temps.some((r) => r.includes('state.json.tmp-')), `${point} — state.json.tmp- orphelin (fuite de temporaires détectée)`)
  }

  // publication : ce qui a déjà pu être remplacé à ce point
  const pub = publishedSnapshot(root)
  const stateIsBase = stateBytesNow().equals(baseStateBytes)
  const viewEvents = () => sortEvents(loadCorpus(root).events)
  let refusedReason = null
  try { const db = openView(root); db.close() } catch (e) { refusedReason = e.message }
  const deltaEventPresent = (evs) => evs.some((e) => e.id === 'msg_d1') &&
    (!mixte || evs.some((e) => e.id === `pi:${piUuid}:ldelta1`))

  if (point === 'avant-staging' || point === 'pendant-staging') {
    assert.deepEqual([...pub.keys()].sort(), [...basePublished.keys()].sort(), `${point} — mêmes fichiers publiés qu'à la base`)
    for (const [k, v] of basePublished) assert.ok(pub.get(k)?.equals(v), `${point} — ${k} inchangé (rien de publié)`)
    assert.ok(stateIsBase, `${point} — state.json inchangé`)
    assert.deepEqual(viewEvents(), baseEvents, `${point} — lectures : dernier état publié (vue)`)
  } else if (point === 'entre-renames') {
    assert.ok(pub.get('sessions.jsonl').equals(basePublished.get('sessions.jsonl')), `${point} — sessions.jsonl pas encore renommé`)
    assert.ok([...pub.keys()].some((k) => k.startsWith('events/') && !pub.get(k).equals(basePublished.get(k))),
      `${point} — au moins un shard déjà remplacé (en avance sur la vue)`)
    assert.deepEqual(viewEvents(), baseEvents, `${point} — la vue ne montre pas les shards en avance`)
  } else if (point === 'dernier-rename-avant-COMMIT') {
    assert.deepEqual([...pub.keys()].filter((k) => k.startsWith('events/')),
      [...basePublished.keys()].filter((k) => k.startsWith('events/')), `${point} — mêmes shards publiés`)
    const inShards = shardEvents(root)
    assert.ok(inShards.some((e) => e.id === 'msg_d1') && (!mixte || inShards.some((e) => e.id === `pi:${piUuid}:ldelta1`)),
      `${point} — les shards déjà remplacés portent le delta (en avance sur la vue)`)
    assert.ok(!pub.get('sessions.jsonl').equals(basePublished.get('sessions.jsonl')), `${point} — métadonnées déjà renommées`)
    assert.ok(stateIsBase, `${point} — state.json en retard`)
    assert.deepEqual(viewEvents(), baseEvents, `${point} — la vue n'a pas COMMITé : lectures = dernier état publié (shards en avance invisibles)`)
    // un shard non touché par le delta reste identique octet par octet
    const untouched = [...pub.keys()].filter((k) => k.startsWith('events/') && pub.get(k).equals(basePublished.get(k)))
    assert.ok(untouched.length >= 1, `${point} — les shards hors delta sont intacts`)
  } else if (point === 'post-COMMIT-avant-état' || point === 'state-tmp-écrit-avant-rename') {
    assert.ok(stateIsBase, `${point} — state.json pas encore écrit`)
    assert.ok(deltaEventPresent(viewEvents()), `${point} — la vue COMMITée montre déjà le delta`)
    if (mixte) {
      const db = (await import('better-sqlite3')).default
      const v = new Database(path.join(root, 'index.db'), { readonly: true })
      try {
        const fresh = checkFresh(root, { db: v })
        assert.equal(fresh.fresh, false, `${point} — divergence pi refusée jusqu'à réconciliation`)
        assert.match(fresh.reason, /jeton divergent/, `${point} — motif nommé (jeton pi)`)
      } finally { v.close() }
      assert.match(refusedReason, /jeton divergent/, `${point} — openView refuse explicitement`)
    }
  } else if (point === 'post-état-avant-retrait-marqueur') {
    assert.ok(!stateIsBase, `${point} — state.json écrit`)
    assert.ok(deltaEventPresent(viewEvents()), `${point} — lectures réussies et cohérentes (delta publié)`)
  }

  // ── reprise ──
  // Reprise OPÉRATEUR du verrou (arrêt coordonné : sortie observée, PID mort,
  // aucun sous-processus — le helper n'en crée pas). Une fois le verrou repris,
  // toute opération d'archive reste refusée sous marqueur non réconcilié —
  // seule la relance de réconciliation (ou recover, décision d'opérateur) passe.
  reclaimLock(root, kid.pid, mode === 'recover' ? `${point} (recover)` : point)
  if (markerExpected) {
    assert.throws(() => fingerprint(root), /marqueur/, `${point} — opération d'archive refusée sous marqueur non réconcilié`)
  }
  if (mode === 'recover') {
    const dbAway = `${dbPath}.hors`
    const piAway = piDir ? `${piDir}.hors` : null
    fs.renameSync(dbPath, dbAway)
    if (mixte) fs.renameSync(piDir, piAway)
    const stBefore = JSON.parse(stateBytesNow().toString())
    const r = await recover(root)
    assert.equal(r.done, true, `${point} — reprise explicite sans source`)
    assert.match(r.note, /reprise explicite/)
    const stAfter = JSON.parse(stateBytesNow().toString())
    assert.deepEqual(stAfter.sources, stBefore.sources, `${point} — watermark conservé par la reprise`)
    assert.equal(ingestRunning(root), false, `${point} — marqueur retiré par la reprise`)
    assertViewEqualsArchive(root)
    assert.equal(stAfter.counts.events, shardEvents(root).length, `${point} — compteurs réécrits depuis l'archive réelle`)
    // convergence à la prochaine ingestion avec sources
    fs.renameSync(dbAway, dbPath)
    if (mixte) fs.renameSync(piAway, piDir)
    await ingest(ocOpts(root, dbPath, piDir))
    assertCorpusEqual(corpusContent(root), canonical, `${point} — convergence après reprise sans sources`)
    assertViewEqualsArchive(root)
  } else {
    // relance AVEC sources (réconciliation) ; le refus tant que le verrou est
    // périmé a déjà été vérifié plus haut, et recover reste le seul chemin
    // explicitement prévu par le protocole sous son propre marqueur
    const r2 = await ingest(ocOpts(root, dbPath, piDir))
    assert.equal(ingestRunning(root), false, `${point} — marqueur retiré par la relance`)
    assert.deepEqual(tempsInventory(root), [], `${point} — tous les temporaires ramassés à la relance`)
    if (POST_COMMIT.has(point)) {
      assert.equal(r2.added, 0, `${point} — relance : ré-application idempotente, aucun doublon`)
    } else {
      assert.deepEqual(
        { added: r2.added, updated: r2.updated, unchanged: r2.unchanged, sessionsAdded: r2.sessionsAdded, sessionsUpdated: r2.sessionsUpdated },
        { added: cDelta.added, updated: cDelta.updated, unchanged: cDelta.unchanged, sessionsAdded: cDelta.sessionsAdded, sessionsUpdated: cDelta.sessionsUpdated },
        `${point} — compteurs de la relance = compteurs de la passe propre`)
    }
    assertCorpusEqual(corpusContent(root), canonical, `${point} — contenu final = canonique attendu`)
    assertViewEqualsArchive(root)
    // zéro doublon : les ids sont uniques dans le contenu final
    const evs = corpusContent(root).events
    assert.equal(new Set(evs.map((e) => e.id)).size, evs.length, `${point} — ids uniques (zéro doublon)`)
  }

  // ── passe SANS changement : octets publiés intacts, aucun doublon ──
  const before = publishedSnapshot(root)
  const r3 = await ingest(ocOpts(root, dbPath, piDir))
  assert.equal(r3.added, 0, `${point} — passe vide : rien d'ajouté`)
  assert.deepEqual(publishedSnapshot(root), before, `${point} — passe vide : octets publiés intacts (idempotence)`)
  assert.deepEqual(tempsInventory(root), [], `${point} — passe vide : aucun temporaire`)
  return { pausedAt: paused.at }
}

// ── Campagne : 2 familles × 7 points, relance avec sources ──
const FAMILIES = { 'opencode seul': 'opencode', mixte: 'mixte' }
for (const [family, familyKey] of Object.entries(FAMILIES)) {
  for (const [point, P] of Object.entries(POINTS)) {
    test(`A3 crash réel — ${family} — ${point} (${P.label})`, { timeout: 60000 }, async (t) => {
      await runCrashScenario(t, { family: familyKey, point })
    })
  }
}

// ── recover SANS sources, scénarios représentatifs (couverture des 2 familles) ──

test('A3 recover sans sources — opencode seul, crash dernier-rename-avant-COMMIT : watermark conservé, vue égale à l\'archive, convergence à la prochaine ingestion', { timeout: 60000 }, async (t) => {
  const { pausedAt } = await runCrashScenario(t, { family: 'opencode', point: 'dernier-rename-avant-COMMIT', mode: 'recover' })
  assert.ok(pausedAt.includes('COMMIT'), `pause au point COMMIT : ${pausedAt}`)
})

test('A3 recover sans sources — mixte, crash post-COMMIT-avant-état : divergence pi réconciliée, watermark conservé, convergence', { timeout: 60000 }, async (t) => {
  const { pausedAt } = await runCrashScenario(t, { family: 'mixte', point: 'post-COMMIT-avant-état', mode: 'recover' })
  assert.ok(pausedAt.includes('state.json.tmp-'), `pause juste avant l'écriture de state.json (après COMMIT) : ${pausedAt}`)
})

test('A3 réconciliation : retirer les temporaires du protocole sans perdre les preuves dont l’id contient .tmp- ou .new-', async (t) => {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'temp-names-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'corpus')
  const dbPath = path.join(dir, 'source.db')
  buildFixtureDb(dbPath)
  await ingest({ root, db: dbPath })
  const proofs = ['prt_keep.tmp-123', 'prt_keep.new-123'].map(id => {
    const file = rawShardPath(path.join(root, 'raw'), id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `preuve synthétique ${id}\n`)
    return { file, bytes: fs.readFileSync(file) }
  })
  const stateTmp = path.join(root, 'state.json.tmp-999')
  const rawTmp = `${proofs[0].file}.new-999`
  fs.writeFileSync(stateTmp, '{}\n')
  fs.writeFileSync(rawTmp, 'staging interrompu\n')
  const viewTemps = ['index.db.new', 'index.db.new-wal', 'index.db.new-shm'].map(name => path.join(root, name))
  for (const file of viewTemps) fs.writeFileSync(file, 'résidu de vue temporaire\n')
  fs.writeFileSync(path.join(root, '.ingest-in-progress'), '{}\n')
  const result = await ingest({ root, db: dbPath })
  assert.equal(result.swept, 5, 'seuls les cinq temporaires du protocole sont ramassés')
  for (const file of [stateTmp, rawTmp, ...viewTemps]) assert.ok(!fs.existsSync(file))
  const files = fingerprint(root).files.map(entry => entry.file)
  for (const { file, bytes } of proofs) {
    assert.deepEqual(fs.readFileSync(file), bytes, 'preuve canonique conservée octet par octet')
    assert.ok(files.includes(path.relative(root, file)), 'preuve incluse dans l’empreinte')
  }
})
