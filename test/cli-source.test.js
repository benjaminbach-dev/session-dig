// Étape 3 du change add-pi-adapter : exposition CLI de la multi-source —
// --source/--pi-dir, filtre de recherche par source (titres compris), scan --raw
// borné, sdig raw pi (rattachée + orpheline), read pi:<uuid> (--around/--at),
// status multi-source, --json avec provenance. Fixtures 100 % synthétiques ;
// home/db/pi-dir tous sous le tmp du test (jamais ~/.pi ni le corpus réel).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import {
  T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession
} from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { rawShardPath } from '../src/layout.js'
import { search, index } from '../src/retriever/bm25.js'
import { rawScan } from '../src/raw.js'
import { sessionSlice } from '../src/read.js'

const cli = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-cli-src-'))
// hermétique, restauré en fin de fichier — SANS cette ligne, le défaut sourcePi()
// pointerait sur le VRAI ~/.pi/agent/sessions (leçon de ce fichier : tout appel
// sans piDir explicite doit rester dans le tmp)
const __prevPiDir = process.env.SESSION_DIG_PI_DIR
const __prevHome = process.env.SESSION_DIG_HOME

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi')
const piDirAbsent = path.join(tmp, 'pi-inexistant')
// hermétique effective : le défaut sourcePi() pointe ici, jamais sur ~/.pi
process.env.SESSION_DIG_PI_DIR = piDir

const text = (s) => ({ type: 'text', text: s })
const toolCallP = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })

// Session pi avec : requête dorée commune (« proxy »), preuve rattachée, orpheline
let piUuid = null
let piOrphanPartId = null
let piRawRef = null

before(async () => {
  buildFixtureDb(dbPath)
  piUuid = fakeUuid()
  writePiSession(piDir, 'proj-a', 'ses_a.jsonl', [
    sessionLine(piUuid, T0, '/root/proj-a'),
    infoLine(T0 + 10, 'Le bug proxy côté pi', 'infa'),
    messageLine(T0 + 1000, { role: 'user', content: [text('le bug proxy renvoie 461 sur le endpoint pi')], timestamp: T0 + 100 }),
    messageLine(T0 + 2000, { role: 'assistant', content: [text('Je vérifie la config.'), toolCallP('c1', 'bash', { command: 'cat proxy.json' })], provider: 'antho', model: 'sonnet-x' }),
    messageLine(T0 + 3000, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [text('timeout: 30\n')], timestamp: T0 + 2500 }),
    messageLine(T0 + 4000, { role: 'bashExecution', command: 'git status', output: 'orphan pi proof marker\n', exitCode: 0, timestamp: T0 + 3500 })
  ])
  // session opencode : la requête dorée historique parle aussi de proxy
  const r = await ingest({ root, db: dbPath, piDir })
  piOrphanPartId = r.pi.orphans[0]
  piRawRef = `pi:${piUuid}:c1`
  index(root)
})

after(() => {
  if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = __prevPiDir
  if (__prevHome === undefined) delete process.env.SESSION_DIG_HOME
  else process.env.SESSION_DIG_HOME = __prevHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

const run = (args) => spawnSync(process.execPath, [cli, ...args, '--home', root], {
  env: { ...process.env, SESSION_DIG_HOME: root },
  encoding: 'utf8'
})

// ═════════ Filtre de recherche --source ═════════

const dbFile = () => path.join(root, 'index.db')

test('recherche sans filtre : hits des deux sources (titres compris)', () => {
  const hits = search(dbFile(), { q: 'proxy', limit: 30, plain: true })
  const sources = new Set(hits.map(h => h.source))
  assert.deepEqual(sources, new Set(['opencode', 'pi']), 'hits des deux sources')
  assert.ok(hits.some(h => h.role === 'title' && h.source === 'pi'), 'titre pi porté et filtrable')
  assert.ok(hits.some(h => h.session_id.startsWith('ses_')), 'hit opencode')
  assert.ok(hits.some(h => h.session_id.startsWith('pi:')), 'hit pi')
})

test('--source pi : seulement pi, titres compris ; --source opencode : seulement opencode', () => {
  const pi = search(dbFile(), { q: 'proxy', limit: 30, plain: true, source: 'pi' })
  assert.ok(pi.length >= 2)
  assert.ok(pi.every(h => h.source === 'pi'), 'tous les hits sont pi')
  assert.ok(pi.some(h => h.role === 'title'), 'lignes de titre pi filtrées comme les messages')
  const oc = search(dbFile(), { q: 'proxy', limit: 30, plain: true, source: 'opencode' })
  assert.ok(oc.length >= 1)
  assert.ok(oc.every(h => h.source === 'opencode'), 'tous les hits sont opencode')
  assert.ok(oc.every(h => !h.session_id.startsWith('pi:')), 'aucune session pi')
})

test('--source inconnue : zéro résultat, pas une erreur', () => {
  const hits = search(dbFile(), { q: 'proxy', limit: 30, plain: true, source: 'warp' })
  assert.deepEqual(hits, [])
})

test('--json (rendu) : source exposée par hit', async () => {
  const { renderJson } = await import('../src/format.js')
  const hits = search(dbFile(), { q: 'proxy', limit: 30, plain: true })
  const rendered = JSON.parse(renderJson(hits))
  assert.ok(rendered.every(h => h.source === 'pi' || h.source === 'opencode'), 'source présente par hit')
  const piHit = rendered.find(h => h.sessionId.startsWith('pi:'))
  assert.equal(piHit.source, 'pi')
})

// ═════════ Scan --raw borné par source ═════════

test('--source pi --raw : preuve pi référencée parcourue, orpheline et opencode exclues', () => {
  // preuve opencode (prt_a1tool) contient « revert ok » ; preuve pi rattachée « timeout: 30 »
  const opencodeProof = rawShardPath(path.join(root, 'raw'), 'prt_a1tool')
  assert.ok(fs.existsSync(opencodeProof), 'preuve opencode présente')
  // scan pi : la preuve rattachée pi est trouvée
  const piScan = rawScan(root, 'timeout', { source: 'pi' })
  assert.ok(piScan.length === 1 && piScan[0].rawRef === piRawRef, 'preuve pi rattachée scannée')
  assert.ok(piScan[0].rawRef.startsWith('pi:'))
  // la preuve opencode n'est pas retournée sous --source pi
  assert.equal(rawScan(root, 'revert ok', { source: 'pi' }).length, 0, 'preuve opencode non lue')
  // l'orpheline pi (sans rawRef) reste hors scan, par conception
  assert.equal(rawScan(root, 'orphan pi proof marker', { source: 'pi' }).length, 0, 'orpheline hors scan')
  // mais elle reste lisible par sdig raw explicite (test dédié ci-dessous)
  // --source opencode : la preuve opencode est trouvée, la pi ignorée
  const ocScan = rawScan(root, 'revert ok', { source: 'opencode' })
  assert.ok(ocScan.length === 1 && ocScan[0].rawRef === 'prt_a1tool', 'preuve opencode scannée')
  assert.equal(rawScan(root, 'timeout: 30', { source: 'opencode' }).length, 0, 'preuve pi non lue (aiguille distincte du timeout de la config opencode)')
  // chemins lus : les seuls fichiers raw compatibles source (vérif d'existence ciblée)
  assert.ok(fs.existsSync(rawShardPath(path.join(root, 'raw'), piRawRef)), 'preuve pi rattachée sur disque')
  assert.ok(fs.existsSync(rawShardPath(path.join(root, 'raw'), piOrphanPartId)), 'orpheline pi sur disque (hors scan)')
})

test('sdig raw : preuve pi rattachée ET orpheline lisibles par partId explicite', () => {
  // rattachée
  const attached = run(['raw', piRawRef])
  assert.equal(attached.status, 0)
  assert.equal(attached.stdout, 'timeout: 30\n')
  // orpheline (partId = pi:<sessionId>:<id de ligne>)
  const orphan = run(['raw', piOrphanPartId])
  assert.equal(orphan.status, 0)
  assert.equal(orphan.stdout, 'orphan pi proof marker\n')
})

// ═════════ sdig read pi:<uuid> ═════════

test('read pi:<uuid> : déroulé complet, --around et --at avec id d événement pi', () => {
  const sessionId = `pi:${piUuid}`
  // session complète
  const full = sessionSlice(root, sessionId, { ctx: 2 })
  assert.ok(full, 'session pi trouvée par id complet préfixé')
  assert.equal(full.ses.source, 'pi')
  assert.ok(full.total >= 2, `${full.total} événements (hors titre : user + assistant)`)
  // --around avec id d'événement pi complet
  const aroundId = full.events.find(e => e.role === 'assistant')?.id
  assert.ok(aroundId, 'id d événement pi disponible')
  const around = sessionSlice(root, sessionId, { aroundId, ctx: 1 })
  assert.ok(around.events.some(e => e.id === aroundId), 'ancre --around dans la fenêtre')
  // --at avec l'id complet d'un événement pi : les messages postérieurs sont masqués
  const lastId = full.events[full.events.length - 1].id
  const at = sessionSlice(root, sessionId, { at: lastId })
  assert.equal(at.maskedCount, 0, 'ancre sur le dernier événement : rien de masqué')
  // ancre au MILIEU (premier événement user) : le message postérieur est masqué
  const firstId = full.events[0].id
  const atMid = sessionSlice(root, sessionId, { at: firstId })
  assert.ok(atMid.maskedCount >= 1, 'ancre au milieu : messages postérieurs masqués')
  assert.equal(atMid.anchor.id, firstId, 'ancre identifiée comme message')
})

// ═════════ CLI : --source sur refresh/ingest, status multi-source ═════════

test('refresh --source pi : delta pi seul, état opencode inchangé', async () => {
  const stBefore = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  assert.ok(stBefore.sources.opencode, 'pré-requis : opencode déjà ingéré')
  // nouveau fichier pi (delta) — opencode inchangé
  const e = fakeUuid()
  writePiSession(piDir, 'proj-b', 'ses_b.jsonl', [
    sessionLine(e, T0 + 86400000, '/root/proj-b'),
    messageLine(T0 + 86400100, { role: 'user', content: [text('nouvelle requête pi après coup')], timestamp: T0 + 86400050 })
  ])
  const r = spawnSync(process.execPath, [cli, 'refresh', '--source', 'pi', '--home', root, '--pi-dir', piDir], {
    env: { ...process.env, SESSION_DIG_HOME: root, SESSION_DIG_PI_DIR: piDir },
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, `refresh --source pi OK (${r.stderr})`)
  assert.match(r.stdout, /pi : \d+ fichier\(s\)/)
  const st = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  assert.deepEqual(st.sources.opencode, stBefore.sources.opencode, 'état opencode inchangé (watermark, jeton)')
  assert.equal(Object.keys(st.sources.pi.files).length, 2, 'nouveau fichier pi suivi')
  // l'événement pi ajouté est cherchable
  const hits = search(dbFile(), { q: 'palettiser', plain: true })
  void hits
  const after = loadPiEvents()
  assert.ok(after.some(x => x.text === 'nouvelle requête pi après coup'), 'delta pi ingéré')
})

function loadPiEvents () {
  const v = new Database(path.join(root, 'index.db'), { readonly: true })
  try {
    return v.prepare("SELECT json FROM events WHERE json LIKE '%\"source\":\"pi\"%' AND role != 'title'")
      .all().map(x => JSON.parse(x.json))
  } finally { v.close() }
}

test('refresh --source pi avec répertoire absent : erreur nommant pi, sortie non nulle', () => {
  const stBefore = fs.readFileSync(path.join(root, 'state.json'), 'utf8')
  const r = run(['refresh', '--source', 'pi', '--pi-dir', piDirAbsent])
  assert.notEqual(r.status, 0, 'échec explicite')
  assert.match(r.stderr, /source pi introuvable/, 'erreur nommant pi')
  assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), stBefore, 'état inchangé (aucun corpus écrit)')
})

test('refresh --source inconnue : erreur dédiée', () => {
  const r = run(['refresh', '--source', 'warp'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /source inconnue : "warp" \(all\|opencode\|pi\)/)
})

test('status : watermarks par source, absence signalée sans erreur', async () => {
  const r = run(['status', '--pi-dir', piDir])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /watermark: message=/, 'watermark opencode affiché')
  assert.match(r.stdout, /pi       : \d+ fichier\(s\) suivi\(s\), jeton [0-9a-f]{8}/, 'pi : fichiers + jeton')
  // avertissement quand le chemin pi configuré a disparu depuis l'ingestion
  const rGone = run(['status', '--pi-dir', piDirAbsent])
  assert.equal(rGone.status, 0, 'absence signalée sans erreur')
  assert.match(rGone.stdout, /source pi configurée introuvable/, 'chemin pi disparu signalé')
  // corpus sans source pi (opencode seule) : « absente — ignorée », pas une erreur
  // — le chemin env est repointé vers un répertoire inexistant (NON explicite :
  // une surcharge opts.piDir manquante serait au contraire une erreur)
  const root2 = path.join(tmp, 'corpus-sans-pi')
  const saved = process.env.SESSION_DIG_PI_DIR
  process.env.SESSION_DIG_PI_DIR = piDirAbsent
  try {
    await ingest({ root: root2, db: dbPath })
  } finally {
    process.env.SESSION_DIG_PI_DIR = saved
  }
  const r2 = spawnSync(process.execPath, [cli, 'status', '--home', root2], {
    env: { ...process.env, SESSION_DIG_HOME: root2, SESSION_DIG_PI_DIR: piDirAbsent },
    encoding: 'utf8'
  })
  assert.equal(r2.status, 0)
  assert.match(r2.stdout, /pi       : absente — ignorée/, 'source pi par défaut absente signalée')
  assert.match(r2.stdout, /watermark: message=/, 'watermark opencode conservé')
})

test('option CLI inconnue : erreur explicite (pas de consommation silencieuse)', () => {
  const r = run(['refresh', '--pi-dirr', piDir])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /option inconnue : --pi-dirr/)
})

// ═════════ Revue finale — bugs A/B de sdig status ═════════

test('status bug B : vue fraîche + source pi qui grandit → disponible, pas « absente », info de croissance', async () => {
  // root DÉDIÉ : ces tests mutent la vue/l'état — jamais le corpus partagé
  const rootB = path.join(tmp, 'corpus-bugb')
  const dir = path.join(tmp, 'pi-bugb')
  const d = fakeUuid()
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(d, T0, '/root/bugb'),
    messageLine(T0 + 1, { role: 'user', content: [text('initial bug b')], timestamp: T0 + 1 })
  ])
  await ingest({ root: rootB, db: dbPath, piDir: dir })
  index(rootB)
  const runOn = (args) => spawnSync(process.execPath, [cli, ...args, '--home', rootB], {
    env: { ...process.env, SESSION_DIG_HOME: rootB, SESSION_DIG_PI_DIR: dir },
    encoding: 'utf8'
  })
  const r1 = runOn(['status'])
  assert.equal(r1.status, 0)
  assert.match(r1.stdout, /vue      : \d+ event\(s\) en vue/, 'vue disponible')
  // un fichier pi grandit APRÈS le refresh : état normal entre deux passes —
  // info de croissance, jamais une indisponibilité
  fs.appendFileSync(path.join(dir, 'd', 'ses.jsonl'),
    messageLine(T0 + 9000, { role: 'user', content: [text('pi grandit entre deux refresh')], timestamp: T0 + 9000 }) + '\n')
  const r2 = runOn(['status'])
  assert.equal(r2.status, 0)
  assert.match(r2.stdout, /vue      : \d+ event\(s\) en vue/, 'vue toujours disponible')
  assert.match(r2.stdout, /ℹ source pi a évolué depuis le dernier refresh/, 'info de croissance (diagnostic seul)')
  assert.ok(!r2.stdout.includes('absente'), 'toujours pas d absence')
  // (nettoyage pour le test suivant, qui réutilise ce root)
  fs.writeFileSync(path.join(rootB, 'state.json'), JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(rootB, 'state.json'), 'utf8')),
    sources: { ...JSON.parse(fs.readFileSync(path.join(rootB, 'state.json'), 'utf8')).sources }
  }))
})

test('status bug B : vue supprimée → « absente » ; jeton divergent → « périmée » nommant pi', async () => {
  const rootB = path.join(tmp, 'corpus-bugb2')
  const dir = path.join(tmp, 'pi-bugb2')
  const d = fakeUuid()
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(d, T0, '/root/bugb2'),
    messageLine(T0 + 1, { role: 'user', content: [text('initial bug b 2')], timestamp: T0 + 1 })
  ])
  await ingest({ root: rootB, db: dbPath, piDir: dir })
  index(rootB)
  const runOn = (args) => spawnSync(process.execPath, [cli, ...args, '--home', rootB], {
    env: { ...process.env, SESSION_DIG_HOME: rootB, SESSION_DIG_PI_DIR: dir },
    encoding: 'utf8'
  })
  // vue supprimée
  const viewFile = path.join(rootB, 'index.db')
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(viewFile + ext, { force: true })
  const r1 = runOn(['status'])
  assert.match(r1.stdout, /vue      : absente \(lancer sdig refresh\)/, 'absence réelle de la vue')
  // jeton divergent : vue reconstruite (index) puis token pi de la VUE réécrit —
  // l'état publié garde le bon jeton → la vue est en retard, la cause nomme pi
  index(rootB)
  const v = new Database(viewFile)
  v.prepare("UPDATE watermark SET token = '00000000000000000000000000000000' WHERE source = 'pi'").run()
  v.close()
  const r2 = runOn(['status'])
  assert.match(r2.stdout, /vue      : périmée \(vue en retard sur la source pi/, 'périmée, source nommée')
  assert.ok(!r2.stdout.includes('absente'), 'présente mais périmée ≠ absente')
})

// garde-fou hermétique : le corpus réel et ~/.pi n'ont jamais été touchés
test('hermétique : aucun chemin réel dans l état du corpus de test', () => {
  const st = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'))
  for (const [name, s] of Object.entries(st.sources)) {
    assert.ok(s.path.startsWith(tmp), `source ${name} dans le tmp du test (${s.path})`)
  }
})

// ═════════ Seconde relecture — bloquants 1-3, corrections 4-6 ═════════

test('--source all : hits, ordre et scores identiques à la recherche sans filtre', () => {
  const def = search(dbFile(), { q: 'proxy', limit: 30, plain: true })
  const all = search(dbFile(), { q: 'proxy', limit: 30, plain: true, source: 'all' })
  assert.deepEqual(all, def, 'all = absence de prédicat (hits, ordre, scores)')
  // et au niveau CLI
  const cliDef = run(['proxy', '--json'])
  const cliAll = run(['proxy', '--json', '--source', 'all'])
  assert.equal(cliAll.stdout, cliDef.stdout, 'CLI : --source all identique au défaut')
})

test('--source inconnue + --raw : succès, zéro hit, aucune preuve (CLI réel)', () => {
  const r = run(['proxy', '--raw', '--source', 'warp'])
  assert.equal(r.status, 0, `succès (${r.stderr})`)
  assert.match(r.stdout, /aucun résultat/, 'zéro hit, zéro preuve affichée')
  assert.ok(!r.stdout.includes('── sorties brutes correspondantes'), 'aucun bloc de scan raw')
})

test('sdig raw : partId hostiles refusés, jamais de lecture hors raw/', () => {
  const hostile = [
    ['../secret.txt', /invalide|hors du répertoire/],          // traversée
    ['..%2fsecret.txt', /partId invalide|hors du répertoire/], // .. littéral
    ['pi:../x:y', /pi invalide|invalide/],                     // / dans le sessionId
    ["pi:aaaa:y/../../etc/passwd", /pi invalide|invalide/],    // / dans le local
    ['pi:aaaa:bb\\cc', /pi invalide|invalide/],                // contre-oblique
    ['ses_fix1/../../../etc/passwd', /partId invalide|hors du répertoire/],
    ['pi:aaaa', /pi invalide/],                                // segment manquant
    ['a:b:c:d', /partId invalide/],                            // ':' réservé à pi (4 segments)
    ['  ses_fix1  ', /partId invalide/],                       // blancs en bord
    ['..', /partId invalide/]
  ]
  for (const [pid, re] of hostile) {
    const r = run(['raw', pid])
    assert.notEqual(r.status, 0, `refus : ${JSON.stringify(pid)}`)
    assert.match(r.stderr, re, `refus nommant la cause : ${JSON.stringify(pid)}`)
  }
  // partId vide : usage
  const rEmpty = run(['raw', ''])
  assert.notEqual(rEmpty.status, 0)
  // lien symbolique vers l'extérieur : refusé (ni lu, ni suivi)
  // préfixe de répartition = md5(partId) — même fonction que layout.js
  const shardPrefix = (id) => crypto.createHash('md5').update(String(id)).digest('hex').slice(0, 2)
  const pfx = shardPrefix('lnk-hostile')
  const dir = path.join(root, 'raw', pfx)
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync('/etc/passwd', path.join(dir, 'lnk-hostile.txt'))
  const rLink = run(['raw', 'lnk-hostile'])
  assert.notEqual(rLink.status, 0, 'symlink refusé')
  assert.match(rLink.stderr, /lien symbolique refusé|ni fichier régulier|introuvable/)
  // le /etc/passwd n'a évidemment pas été affiché
  assert.ok(!rLink.stdout.includes('root:'))
})

test('commandes suggérées citables : partId avec | ou quote est shell-quoté', async () => {
  const { shellQuoteArg, renderEvent } = await import('../src/format.js')
  assert.equal(shellQuoteArg('prt_a1tool'), 'prt_a1tool', 'partId sûr : inchangé (sorties héritées stables)')
  assert.equal(shellQuoteArg('pi:aaaa:call_x|fc_y'), "'pi:aaaa:call_x|fc_y'", 'pipe quoté')
  assert.equal(shellQuoteArg("pi:aaaa:l'1"), `'pi:aaaa:l'\\''1'`, 'quote interne échappée')
  // rendu complet : la commande affichée est recopiable telle quelle
  const ev = { ts: T0, role: 'assistant', sessionId: 'pi:x', id: 'pi:x', text: 'x', toolCalls: [{ tool: 'bash', cmd: 'ls', rawRef: "pi:aaaa:call_x|fc_y" }] }
  const out = renderEvent(ev, { plain: true })
  assert.ok(out.includes("sdig raw 'pi:aaaa:call_x|fc_y'"), `affichage citable : ${out}`)
  // renderRawHits : même politique
  const { renderRawHits } = await import('../src/format.js')
  const rawOut = renderRawHits([{ ts: T0, tool: 'bash', sessionId: 'pi:x', cmd: 'ls', line: 'x', lineNo: 1, rawRef: 'pi:a|b' }])
  assert.ok(rawOut.includes("sdig raw 'pi:a|b'"), 'renderRawHits citable')
})

test('status : pi présent mais pas encore ingérée ; corpus pi-only sans watermark opencode factice', async () => {
  const { renderStatus } = await import('../src/format.js')
  // pi : répertoire configuré présent mais jamais ingéré (ingestion source:opencode)
  const rootT = path.join(tmp, 'corpus-status-pi-pending')
  await ingest({ root: rootT, db: dbPath, piDir, source: 'opencode' })
  const st = JSON.parse(fs.readFileSync(path.join(rootT, 'state.json'), 'utf8'))
  assert.equal(st.sources.pi, undefined, 'pi non ingéré')
  // la ligne pi est imprimée par le CLI (après renderStatus) — tester le câblage réel
  const rStatus = spawnSync(process.execPath, [cli, 'status', '--home', rootT, '--pi-dir', piDir], {
    env: { ...process.env, SESSION_DIG_HOME: rootT, SESSION_DIG_PI_DIR: piDir },
    encoding: 'utf8'
  })
  assert.equal(rStatus.status, 0)
  assert.match(rStatus.stdout, /pi       : pas encore ingérée/, 'pi présent mais pas encore ingérée')
  assert.ok(!rStatus.stdout.includes('absente — ignorée'), 'pas « absente » : le répertoire existe')
  // corpus pi-only : opencode absente → absence réelle, jamais watermark 0/0
  const rootP = path.join(tmp, 'corpus-pi-only-status')
  const prevEnv = process.env.SESSION_DIG_DB
  process.env.SESSION_DIG_DB = path.join(tmp, 'opencode-absente.db')
  try {
    await ingest({ root: rootP, piDir })
  } finally {
    if (prevEnv === undefined) delete process.env.SESSION_DIG_DB
    else process.env.SESSION_DIG_DB = prevEnv
  }
  const stP = JSON.parse(fs.readFileSync(path.join(rootP, 'state.json'), 'utf8'))
  assert.equal(stP.sources.opencode, undefined)
  const outP = renderStatus({
    counts: stP.counts, rawFiles: 0, layout: 2,
    watermark: null, ocPath: path.join(tmp, 'opencode-absente.db'),
    view: null
  }, { root: rootP })
  assert.match(outP, /opencode : absente — ignorée/, 'absence réelle de la source opencode affichée')
  assert.ok(!outP.includes('watermark: message=0'), 'jamais de watermark 0/0 trompeur')
})

test('CLI réel : recherche --source pi vs sans filtre ; read --around/--at ; --json par hit', () => {
  // sans filtre : hits des deux sources ; --source pi : uniquement pi
  const def = JSON.parse(run(['proxy', '--json']).stdout)
  assert.ok(def.some(h => h.sessionId.startsWith('ses_')) && def.some(h => h.sessionId.startsWith('pi:')))
  const pi = JSON.parse(run(['proxy', '--json', '--source', 'pi']).stdout)
  assert.ok(pi.length >= 1)
  assert.ok(pi.every(h => h.source === 'pi'), 'source=pi par hit en --json')
  assert.ok(!pi.some(h => h.sessionId.startsWith('ses_')), 'opencode exclu')
  // read --around via le CLI
  const sessionId = `pi:${piUuid}`
  // D1 amendé : id d'événement QUALIFIÉ par session (pi:<sessionId>:<id de ligne>)
  const aroundId = loadPiEvents().find(e => e.role === 'assistant')?.id
  assert.match(aroundId, /^pi:[^:]+:[^:]+$/, `id d'événement qualifié (${aroundId})`)
  const rAround = run(['read', sessionId, '--around', aroundId, '--ctx', '1'])
  assert.equal(rAround.status, 0)
  assert.match(rAround.stdout, /Je vérifie la config/)
  // read --at via le CLI (ancre = id complet du premier événement pi)
  const firstId = loadPiEvents().find(e => e.role === 'user')?.id
  const rAt = run(['read', sessionId, '--at', firstId])
  assert.equal(rAt.status, 0)
  assert.match(rAt.stdout, /masqué|titre|user/, 'sortie de lecture rendue')
  assert.ok(rAt.stdout.includes('Le bug proxy côté pi'), 'titre pi affiché')
})
