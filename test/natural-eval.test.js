// Évaluation naturelle : extraction/build sur la VUE v2 (openView + inReadTx), jamais
// sur les fichiers v1 `events.jsonl`/`sessions.jsonl`. Fixtures 100 % synthétiques
// sous tmp ; le jeu gelé `eval/natural` n'est jamais lu ni écrit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { buildFixtureDb, T0 } from './helpers/fixture.js'
import { fakeUuid, sessionLine, messageLine, infoLine, writePiSession, T0 as T0PI } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'

const EXTRACT = fileURLToPath(new URL('../scripts/natural-extract.mjs', import.meta.url))
const BUILD = fileURLToPath(new URL('../scripts/natural-build.mjs', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-natural-'))
const __prevPiDir = process.env.SESSION_DIG_PI_DIR

const source = path.join(tmp, 'source.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi')
process.env.SESSION_DIG_PI_DIR = piDir

const A0 = T0 + 1_000_000
const LONG = (s) => `${s} ${'Détail complémentaire sur config.json et /etc/proxy.conf. '.repeat(8)}`

function addMsg (db, { sid, mid, text, ts, role, agent = 'build', parentId = null }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?,?)')
    .run(sid, 'p', parentId, `/root/${sid}`, `Nat ${sid}`, ts, ts)
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    .run(mid, sid, ts, ts, JSON.stringify({ role, agent, providerID: 'p', modelID: 'm' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
    .run(`prt_${mid}`, mid, sid, ts, ts, JSON.stringify({ type: 'text', text }))
}

let piSessionId = null
let msgBNatB = null
let msgANatA = null

before(async () => {
  buildFixtureDb(source)
  const db = new Database(source)
  try {
    addMsg(db, { sid: 'ses_nat_a', mid: 'msg_nat_u1', role: 'user', ts: A0, text: 'Pourquoi le proxy renvoie 461 sur /api/go en fin de mois ?' })
    addMsg(db, { sid: 'ses_nat_a', mid: 'msg_nat_a1', role: 'assistant', ts: A0 + 1, text: LONG('Le proxy renvoie 461 à cause du timeout trop court dans config.json.') })
    addMsg(db, { sid: 'ses_nat_a', mid: 'msg_nat_u2', role: 'user', ts: A0 + 1000, text: 'Comment corriger le timeout upstream dans config.yaml ?' })
    addMsg(db, { sid: 'ses_nat_a', mid: 'msg_nat_a2', role: 'assistant', ts: A0 + 1001, text: LONG('Corrige le timeout dans config.yaml en passant la valeur à 30.') })
    // Tie de timestamp : user et assistant au MÊME ts ; l'ordre (ts, id) doit placer le user d'abord.
    addMsg(db, { sid: 'ses_nat_a', mid: 'msg_nat_tieu', role: 'user', ts: A0 + 2000, text: 'Quel port par défaut utiliser pour le proxy dans config.json ?' })
    addMsg(db, { sid: 'ses_nat_a', mid: 'msg_nat_tiez', role: 'assistant', ts: A0 + 2000, text: LONG('Le port par défaut est 8080 dans config.json.') })
    // Sous-session : exclue du tirage.
    addMsg(db, { sid: 'ses_nat_sub', mid: 'msg_nat_sub_u', role: 'user', ts: A0 + 3000, parentId: 'ses_nat_a', text: 'Pourquoi la sous-session est-elle exclue du tirage ?' })
    addMsg(db, { sid: 'ses_nat_sub', mid: 'msg_nat_sub_a', role: 'assistant', ts: A0 + 3001, parentId: 'ses_nat_a', text: LONG('La sous-session est exclue car parentSession est renseigné.') })
    // Autre session (test d'appartenance).
    addMsg(db, { sid: 'ses_nat_b', mid: 'msg_nat_b_u', role: 'user', ts: A0 + 4000, text: 'Où se trouve le fichier de configuration du thème sombre ?' })
    addMsg(db, { sid: 'ses_nat_b', mid: 'msg_nat_b_a', role: 'assistant', ts: A0 + 4001, text: LONG('Le thème sombre lit /root/theme-kit/theme.json au démarrage.') })
    msgBNatB = 'msg_nat_b_u'
    msgANatA = 'msg_nat_a1'
  } finally { db.close() }

  piSessionId = `pi:${fakeUuid()}`
  writePiSession(piDir, 'proj-nat', 'ses-nat.jsonl', [
    sessionLine(piSessionId.slice(3), T0PI, '/root/pi-projet'),
    infoLine(T0PI + 10, 'Nat pi', 'nat-info'),
    messageLine(T0PI + 1000, { role: 'user', content: [{ type: 'text', text: 'Pourquoi le build échoue-t-il sur /root/pi-projet ?' }], timestamp: T0PI + 900 }),
    messageLine(T0PI + 2000, { role: 'assistant', content: [{ type: 'text', text: LONG('Le build échoue car /root/pi-projet/config.json référence un chemin absent.') }], provider: 'antho', model: 'sonnet-x', timestamp: T0PI + 1900 })
  ])

  await ingest({ root, db: source, piDir, source: 'all' })

  // Fichier v1 RÉSIDUEL : ne doit JAMAIS être lu (la vue v2 fait foi).
  fs.writeFileSync(path.join(root, 'events.jsonl'), JSON.stringify({
    schemaVersion: 1, id: 'msg_v1only', sessionId: 'ses_v1only', ts: A0, role: 'user', text: 'Pourquoi ce fichier v1 résiduel ne doit-il jamais être lu ?', model: null, agent: 'build'
  }) + '\n')
  fs.writeFileSync(path.join(root, 'sessions.jsonl'), JSON.stringify({ schemaVersion: 1, id: 'ses_v1only', title: 'V1 résiduel', repo: 'v1', directory: '/root/v1', tsCreated: A0, tsUpdated: A0 }) + '\n')
})

after(() => {
  if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = __prevPiDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

function run (script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, SESSION_DIG_PI_DIR: piDir },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32 << 20
  })
}

const readLines = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

test('extraction : vue v2 frais, déterministe, ignore events.jsonl v1 résiduel', () => {
  const out1 = path.join(tmp, 'out1')
  const out2 = path.join(tmp, 'out2')
  const r1 = run(EXTRACT, ['--n', '50', '--seed', '20260918', '--cap', '30', '--out', out1, '--home', root])
  assert.equal(r1.status, 0, r1.stderr)
  const r2 = run(EXTRACT, ['--n', '50', '--seed', '20260918', '--cap', '30', '--out', out2, '--home', root])
  assert.equal(r2.status, 0, r2.stderr)
  assert.equal(fs.readFileSync(path.join(out1, 'sample.jsonl'), 'utf8'), fs.readFileSync(path.join(out2, 'sample.jsonl'), 'utf8'), 'même graine ⇒ même échantillon (octet pour octet)')

  const cands = readLines(path.join(out1, 'candidates.jsonl'))
  const sids = new Set(cands.map(c => c.sessionId))
  assert.ok(sids.has('ses_nat_a'), 'session opencode présente')
  assert.ok([...sids].some(s => s.startsWith('pi:')), 'session pi présente')
  assert.ok(!sids.has('ses_v1only'), 'le fichier v1 résiduel n’est jamais lu')
  assert.ok(!sids.has('ses_nat_sub'), 'sous-session exclue du tirage')
  assert.ok(cands.every(c => c.sessionId !== 'ses_v1only'))
})

test('extraction : tie de timestamp ordonné par (ts, id) — le user précède son assistant', () => {
  const out = path.join(tmp, 'out-tie')
  const r = run(EXTRACT, ['--n', '50', '--seed', '20260918', '--out', out, '--home', root])
  assert.equal(r.status, 0, r.stderr)
  const cands = readLines(path.join(out, 'candidates.jsonl'))
  const tie = cands.find(c => c.userMsgId === 'msg_nat_tieu')
  assert.ok(tie, 'candidat du tie présent (user avant assistant au même ts)')
  assert.equal(tie.sessionId, 'ses_nat_a')
})

test('extraction : vue absente refusée explicitement, aucune sortie produite', () => {
  const emptyRoot = path.join(tmp, 'corpus-vide')
  fs.mkdirSync(emptyRoot, { recursive: true })
  const out = path.join(tmp, 'out-missing')
  const r = run(EXTRACT, ['--out', out, '--home', emptyRoot])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /vue dérivable absente/)
  assert.equal(fs.existsSync(out), false, 'aucun répertoire de sortie créé')
})

test('extraction : source absente du disque n’empêche pas l’archive via la vue', () => {
  const bak = `${source}.bak`
  fs.renameSync(source, bak)
  try {
    const out = path.join(tmp, 'out-nosource')
    const r = run(EXTRACT, ['--n', '50', '--seed', '20260918', '--out', out, '--home', root])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(fs.existsSync(path.join(out, 'sample.jsonl')), 'archive lue sans source sur disque')
  } finally { fs.renameSync(bak, source) }
})

test('extraction : vue périmée refusée avant sortie', () => {
  const statePath = path.join(root, 'state.json')
  const saved = fs.readFileSync(statePath, 'utf8')
  const out = path.join(tmp, 'out-stale')
  try {
    const st = JSON.parse(saved)
    st.sources.opencode.message = (st.sources.opencode.message ?? 0) + 1_000_000 // vue en retard
    fs.writeFileSync(statePath, JSON.stringify(st))
    const r = run(EXTRACT, ['--out', out, '--home', root])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /vue en retard|refresh/)
    assert.equal(fs.existsSync(out), false)
  } finally { fs.writeFileSync(statePath, saved) }
})

test('build : paire valide écrite, appartenance userMsgId ↔ sessionId vérifiée', () => {
  const out = path.join(tmp, 'build-ok')
  const r = run(EXTRACT, ['--n', '50', '--seed', '20260918', '--out', out, '--home', root])
  assert.equal(r.status, 0, r.stderr)
  const sample = readLines(path.join(out, 'sample.jsonl'))
  const src = sample.find(c => c.sessionId === 'ses_nat_a' && c.userMsgId === 'msg_nat_u1')
  assert.ok(src)
  fs.writeFileSync(path.join(out, 'curated.json'), JSON.stringify([{
    qid: src.qid, expect: ['le timeout est trop court', 'config.json est concerné'], type: 'fait', specificity: 'high', selfContained: true
  }]))
  const b = run(BUILD, ['--out', out, '--home', root])
  assert.equal(b.status, 0, b.stderr)
  const qs = readLines(path.join(out, 'questions.jsonl'))
  assert.equal(qs.length, 1)
  assert.equal(qs[0].provenance.userMsgId, 'msg_nat_u1')
  assert.equal(qs[0].provenance.sessionId, 'ses_nat_a')
  assert.ok(qs[0].expect.length >= 2)
})

const NAT_Q = 'Pourquoi le proxy renvoie 461 sur /api/go en fin de mois ?'
const natSample = (over = {}) => ({
  qid: 'q001', sessionId: 'ses_nat_a', sessionTitle: 'Nat A', repo: 'repo-a', directory: '/root/repo-a',
  ts: A0, date: '2026-01-01', userMsgId: 'msg_nat_u1', model: null, question: NAT_Q, ...over
})
const natCurated = (over = {}) => [{ qid: 'q001', expect: ['fait un', 'fait deux'], type: 'fait', specificity: 'high', selfContained: true, ...over }]

function writeBuildInputs (out, sample, curated) {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'sample.jsonl'), JSON.stringify(sample) + '\n')
  fs.writeFileSync(path.join(out, 'curated.json'), JSON.stringify(curated))
}

test('build : texte du tirage non conforme (même préfixe 40, queue inventée) refusé sans sortie', () => {
  const out = path.join(tmp, 'build-mismatch')
  writeBuildInputs(out, natSample({ question: `${NAT_Q} QUEUE INVENTÉE` }), natCurated())
  const r = run(BUILD, ['--out', out, '--home', root])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /EXACTEMENT/)
  assert.equal(fs.existsSync(path.join(out, 'questions.jsonl')), false)
})

test('build : espaces/artefacts client nettoyés acceptés (égalité après nettoyage)', () => {
  const out = path.join(tmp, 'build-clean')
  writeBuildInputs(out, natSample({ question: `  ${NAT_Q}  <system-reminder>ignore-moi</system-reminder>\n\n` }), natCurated())
  const r = run(BUILD, ['--out', out, '--home', root])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readLines(path.join(out, 'questions.jsonl')).length, 1)
})

test('build : curation incomplète (expect < 2, étiquettes invalides) refusée sans sortie', () => {
  const cases = [
    { name: 'expect1', curated: natCurated({ expect: ['un seul'] }), motif: /au moins 2 faits/ },
    { name: 'type-invalide', curated: natCurated({ type: 'autre' }), motif: /type invalide/ },
    { name: 'spec-invalide', curated: natCurated({ specificity: 'énorme' }), motif: /specificity invalide/ },
    { name: 'selfcontained-manquant', curated: [{ qid: 'q001', expect: ['a', 'b'], type: 'fait', specificity: 'high' }], motif: /selfContained/ }
  ]
  for (const c of cases) {
    const out = path.join(tmp, `build-${c.name}`)
    writeBuildInputs(out, natSample(), c.curated)
    const r = run(BUILD, ['--out', out, '--home', root])
    assert.equal(r.status, 1, c.name)
    assert.match(r.stderr, c.motif)
    assert.equal(fs.existsSync(path.join(out, 'questions.jsonl')), false, `${c.name} : aucun jeu partiel`)
  }
})

test('build : vue périmée refusée avant écriture', () => {
  const out = path.join(tmp, 'build-stale')
  writeBuildInputs(out, natSample(), natCurated())
  const statePath = path.join(root, 'state.json')
  const saved = fs.readFileSync(statePath, 'utf8')
  try {
    const st = JSON.parse(saved)
    st.sources.opencode.message = (st.sources.opencode.message ?? 0) + 1_000_000
    fs.writeFileSync(statePath, JSON.stringify(st))
    const r = run(BUILD, ['--out', out, '--home', root])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /vue en retard|refresh/)
    assert.equal(fs.existsSync(path.join(out, 'questions.jsonl')), false)
  } finally { fs.writeFileSync(statePath, saved) }
})

test('build : vue de layout non supporté refusée avant écriture', () => {
  const layoutRoot = path.join(tmp, 'corpus-layout')
  fs.cpSync(root, layoutRoot, { recursive: true })
  const vdb = new Database(path.join(layoutRoot, 'index.db'))
  try { vdb.prepare("UPDATE meta SET value = '1' WHERE key = 'layoutVersion'").run() } finally { vdb.close() }
  const out = path.join(tmp, 'build-layout')
  writeBuildInputs(out, natSample(), natCurated())
  const r = run(BUILD, ['--out', out, '--home', layoutRoot])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /layout non support/)
  assert.equal(fs.existsSync(path.join(out, 'questions.jsonl')), false)
})

test('build : userMsgId d’une AUTRE session refusé, aucun jeu partiel', () => {
  const out = path.join(tmp, 'build-other')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'sample.jsonl'), JSON.stringify({
    qid: 'q001', sessionId: 'ses_nat_a', sessionTitle: 'Nat A', repo: 'repo-a', directory: '/root/repo-a',
    ts: A0, date: '2026-01-01', userMsgId: msgBNatB, model: null,
    question: 'Pourquoi le proxy renvoie 461 sur /api/go en fin de mois ?'
  }) + '\n')
  fs.writeFileSync(path.join(out, 'curated.json'), JSON.stringify([{ qid: 'q001', expect: ['a', 'b'], type: 'fait', specificity: 'high', selfContained: true }]))
  const r = run(BUILD, ['--out', out, '--home', root])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /absent de la session/)
  assert.equal(fs.existsSync(path.join(out, 'questions.jsonl')), false, 'aucun jeu partiel écrit')
})

test('build : message non-user et session inconnue refusés', () => {
  const cases = [
    { name: 'non-user', sessionId: 'ses_nat_a', userMsgId: msgANatA, motif: /absent de la session|non-user/ },
    { name: 'session-inconnue', sessionId: 'ses_absent', userMsgId: 'msg_nat_u1', motif: /introuvable dans la vue/ }
  ]
  for (const c of cases) {
    const out = path.join(tmp, `build-${c.name}`)
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'sample.jsonl'), JSON.stringify({
      qid: 'q001', sessionId: c.sessionId, sessionTitle: 'X', repo: null, directory: null,
      ts: A0, date: '2026-01-01', userMsgId: c.userMsgId, model: null,
      question: 'Pourquoi le proxy renvoie 461 sur /api/go en fin de mois ?'
    }) + '\n')
    fs.writeFileSync(path.join(out, 'curated.json'), JSON.stringify([{ qid: 'q001', expect: ['a', 'b'], type: 'fait', specificity: 'high', selfContained: true }]))
    const r = run(BUILD, ['--out', out, '--home', root])
    assert.equal(r.status, 1, c.name)
    assert.match(r.stderr, c.motif)
    assert.equal(fs.existsSync(path.join(out, 'questions.jsonl')), false, `${c.name} : aucun jeu partiel`)
  }
})

test('build : vue absente refusée avant toute écriture', () => {
  const out = path.join(tmp, 'build-missing')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'sample.jsonl'), '')
  fs.writeFileSync(path.join(out, 'curated.json'), '[]')
  const emptyRoot = path.join(tmp, 'corpus-vide-2')
  fs.mkdirSync(emptyRoot, { recursive: true })
  const r = run(BUILD, ['--out', out, '--home', emptyRoot])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /vue dérivable absente/)
  assert.equal(fs.existsSync(path.join(out, 'questions.jsonl')), false)
})
