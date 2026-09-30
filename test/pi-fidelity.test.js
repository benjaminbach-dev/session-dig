// Complément add-pi-adapter — signal de limites de fidélité pi dans les résultats.
// Fixtures 100 % synthétiques (D6) ; source pi explicitement sous le tmp du test,
// jamais le ~/.pi réel. On vérifie la présence/absence du signal, la validité du
// JSON et l'invariance des contenus/comptes — jamais une détection de branche.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildFixtureDb } from './helpers/fixture.js'
import {
  T0 as T0PI, fakeUuid, sessionLine, messageLine, infoLine, writePiSession
} from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { loadCorpus } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { sessionSlice } from '../src/read.js'
import {
  renderTerminal, renderJson, renderRead, renderReadJson,
  PI_FIDELITY_LIMITS, PI_FIDELITY_NOTE, piFidelityWarning
} from '../src/format.js'

const cli = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-pi-fid-'))
const __prevPiDir = process.env.SESSION_DIG_PI_DIR
const __prevHome = process.env.SESSION_DIG_HOME

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi')
process.env.SESSION_DIG_PI_DIR = piDir

const text = (s) => ({ type: 'text', text: s })
let piUuid = null
const piSessionId = () => `pi:${piUuid}`

before(async () => {
  buildFixtureDb(dbPath)
  piUuid = fakeUuid()
  // Titre pi porteur du mot « proxy » (requête mixte, sans message pi) et du mot
  // unique « zephyrine » (titre pi SEUL) ; messages pi sans ces mots.
  writePiSession(piDir, 'proj-fid', 'ses_fid.jsonl', [
    sessionLine(piUuid, T0PI, '/root/proj-fid'),
    infoLine(T0PI + 10, 'Fix bug proxy 461 côté zephyrine', 'infF'),
    messageLine(T0PI + 1000, {
      role: 'user',
      content: [text('premier message pi, note de terrain')],
      timestamp: T0PI + 100
    }),
    messageLine(T0PI + 2000, {
      role: 'assistant',
      content: [text('second message pi, suite du diagnostic')],
      provider: 'antho',
      model: 'sonnet-x',
      timestamp: T0PI + 1500
    })
  ])
  await ingest({ root, db: dbPath, piDir })
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

const PI_WARN = () => piFidelityWarning()

// ═════════ Signal de recherche ═════════

test('recherche mixte (hits opencode + titre pi) : signal pi, jamais attribué à opencode', () => {
  const r = run(['proxy', '--limit', '50'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /⚠ fidélité pi/)
  assert.ok(r.stdout.includes('zephyrine'), 'titre pi effectivement rendu')
  assert.ok(r.stdout.includes(PI_FIDELITY_LIMITS[0]), 'limite « branches aplaties » affichée')
  assert.ok(r.stdout.includes(PI_FIDELITY_LIMITS[1]), 'limite « context_edit » affichée')

  const j = JSON.parse(run(['proxy', '--limit', '50', '--json']).stdout)
  assert.ok(Array.isArray(j), 'la recherche JSON reste un TABLEAU (jamais un objet enveloppe)')
  const piHit = j.find(h => h.source === 'pi')
  assert.ok(piHit, 'un hit pi (titre) est présent')
  assert.equal(piHit.role, 'title')
  assert.equal(piHit.fidelity.source, 'pi')
  assert.equal(piHit.fidelity.general, true, 'signal déclaré général (pas une détection de session)')
  assert.deepEqual(piHit.fidelity.limits, [...PI_FIDELITY_LIMITS])
  assert.equal(piHit.fidelity.note, PI_FIDELITY_NOTE)
  const ocHits = j.filter(h => h.source === 'opencode')
  assert.ok(ocHits.length >= 1, 'hits opencode présents')
  assert.ok(ocHits.every(h => h.fidelity === undefined), 'aucune métadonnée pi sur les hits opencode')
})

test('titre pi seul : signal présent en terminal et en JSON', () => {
  const r = run(['zephyrine'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /⚠ fidélité pi/)
  const raw = run(['zephyrine', '--json']).stdout
  const j = JSON.parse(raw)
  assert.equal(j.length, 1, 'seul le titre pi correspond')
  assert.equal(j[0].source, 'pi')
  assert.equal(j[0].role, 'title')
  assert.ok(j[0].fidelity, 'métadonnée structurée présente')
  assert.ok(!raw.includes('⚠'), 'aucun texte terminal hors JSON')
})

test('recherche opencode-only : aucun signal pi', () => {
  const r = run(['lila'])
  assert.equal(r.status, 0)
  assert.ok(!/fidélité pi/.test(r.stdout), 'pas de signal sans donnée pi rendue')
  const j = JSON.parse(run(['lila', '--json']).stdout)
  assert.ok(j.length >= 1)
  assert.ok(j.every(h => h.source === 'opencode'), 'hits opencode uniquement')
  assert.ok(j.every(h => h.fidelity === undefined))
})

test('recherche sans résultat : aucun signal pi', () => {
  const r = run(['xyzzyplugh'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /aucun résultat/)
  assert.ok(!/fidélité pi/.test(r.stdout))
  const raw = run(['xyzzyplugh', '--json']).stdout
  assert.deepEqual(JSON.parse(raw), [])
  assert.ok(!raw.includes('fidélité pi'))
})

test('voisin pi rendu : signal déclenché même quand le hit n’est pas pi (chemin de rendu)', () => {
  const sesMeta = new Map([['ses_oc', { id: 'ses_oc', title: 't', repo: 'r', tsCreated: 1, source: 'opencode' }]])
  const hits = [{ id: 'oc1', session_id: 'ses_oc', ts: 1, role: 'user', source: 'opencode', text: 'x', snip: 'x' }]
  const withPiVoisin = new Map([['ses_oc', {
    total: 2,
    evs: [
      { id: 'oc1', session_id: 'ses_oc', ts: 1, role: 'user', source: 'opencode', text: 'x' },
      { id: 'pi1', session_id: 'ses_oc', ts: 2, role: 'assistant', source: 'pi', text: 'y' }
    ],
    absIdx: [0, 1]
  }]])
  const opencodeOnly = new Map([['ses_oc', {
    total: 1,
    evs: [{ id: 'oc1', session_id: 'ses_oc', ts: 1, role: 'user', source: 'opencode', text: 'x' }],
    absIdx: [0]
  }]])
  const outPi = renderTerminal(hits, sesMeta, { ctx: 1, ctxBySession: withPiVoisin })
  assert.ok(outPi.includes(PI_WARN()), 'voisin pi → signal')
  const outOc = renderTerminal(hits, sesMeta, { ctx: 1, ctxBySession: opencodeOnly })
  assert.ok(!outOc.includes('fidélité pi'), 'queue opencode sans voisin pi → aucun signal')
})

test('recherche --ctx : voisins pi rendus via le vrai chemin (neighborsBySessionDb)', () => {
  const r = run(['zephyrine', '--ctx', '1'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /⚠ fidélité pi/)
  assert.ok(r.stdout.includes('premier message pi'), 'voisin pi réellement rendu')
})

test('JSON de recherche : valide, sans parasite, contenus et comptes inchangés', () => {
  const raw = run(['proxy', '--limit', '50', '--json']).stdout
  assert.doesNotThrow(() => JSON.parse(raw), 'JSON valide')
  assert.ok(!raw.includes('⚠'), 'aucun caractère de rendu terminal dans le JSON')
  const j = JSON.parse(raw)
  const direct = search(path.join(root, 'index.db'), { q: 'proxy', limit: 50, plain: true })
  assert.equal(j.length, direct.length, 'même nombre de hits que la recherche directe')
  for (const h of direct) {
    const jh = j.find(x => x.id === h.id && x.sessionId === h.session_id)
    assert.ok(jh, `hit ${h.id} présent`)
    assert.equal(jh.text, h.text ?? undefined, 'texte du hit inchangé')
    assert.equal(jh.ts, h.ts, 'horodatage inchangé')
  }
})

// ═════════ Signal de lecture ═════════

test('lecture pi sans ancre : signal présent, contenu et compteurs inchangés', () => {
  const slice = sessionSlice(root, piSessionId())
  assert.equal(slice.total, 2)
  const out = renderRead(slice, piSessionId())
  assert.ok(out.includes(PI_WARN()), 'signal terminal présent')
  const j = JSON.parse(renderReadJson(slice, piSessionId()))
  assert.equal(j.total, 2)
  assert.equal(j.messages.length, 2, 'aucun message ajouté/retiré')
  assert.ok(j.messages.some(m => m.text.includes('premier message pi')))
  assert.equal(j.fidelity.source, 'pi')
  assert.deepEqual(j.fidelity.limits, [...PI_FIDELITY_LIMITS])
})

test('lecture pi ancrée et vide : ancre + compteurs conservés, signal présent', () => {
  const at = String(T0PI) // epoch ms 13 chiffres, antérieur au 1er message
  const slice = sessionSlice(root, piSessionId(), { at })
  assert.equal(slice.total, 2)
  assert.equal(slice.maxIdx, -1)
  assert.equal(slice.maskedCount, 2)
  assert.ok(slice.error, 'message d’absence de message à l’ancre conservé')
  const out = renderRead(slice, piSessionId())
  assert.match(out, /ancre/)
  assert.ok(out.includes(PI_WARN()), 'session pi connue vide à l’ancre → signal conservé')
  const j = JSON.parse(renderReadJson(slice, piSessionId()))
  assert.equal(j.anchor.ts, T0PI)
  assert.equal(j.anchor.id, null)
  assert.equal(j.maskedCount, 2)
  assert.equal(j.visible, 0)
  assert.equal(j.messages.length, 0)
  assert.ok(j.fidelity, 'métadonnée pi conservée sur lecture vide')
})

test('e2e read pi:<uuid> --at <idMsg> --json (ancre NON vide) : fidelity racine, contenus/comptes/ancre exacts', () => {
  const firstMsg = loadCorpus(root).events.find(e => e.sessionId === piSessionId() && e.role === 'user')
  assert.ok(firstMsg, 'message user pi présent')
  const r = run(['read', piSessionId(), '--at', firstMsg.id, '--json'])
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '', 'stderr vide — aucune sortie parasite')
  assert.ok(!r.stdout.includes('⚠'), 'stdout = JSON seul, sans décor de rendu')
  const j = JSON.parse(r.stdout) // JSON valide (lève sinon)
  // métadonnée de fidélité RACINE, associée à pi
  assert.equal(j.fidelity.source, 'pi')
  assert.equal(j.fidelity.general, true)
  assert.deepEqual(j.fidelity.limits, [...PI_FIDELITY_LIMITS])
  // ancre NON VIDE = id de message de la session
  assert.equal(j.anchor.id, firstMsg.id)
  assert.equal(j.anchor.source, 'message')
  assert.equal(j.anchor.ts, firstMsg.ts)
  // ancre et compteurs inchangés
  assert.equal(j.total, 2)
  assert.equal(j.visible, 1)
  assert.equal(j.maskedCount, 1)
  // message visible exact
  assert.equal(j.messages.length, 1)
  assert.equal(j.messages[0].id, firstMsg.id)
  assert.equal(j.messages[0].index, 0)
  assert.equal(j.messages[0].role, 'user')
  assert.equal(j.messages[0].text, 'premier message pi, note de terrain')
})

test('lecture opencode : aucun signal pi', () => {
  const slice = sessionSlice(root, 'ses_fix1')
  const out = renderRead(slice, 'ses_fix1')
  assert.ok(!/fidélité pi/.test(out))
  const j = JSON.parse(renderReadJson(slice, 'ses_fix1'))
  assert.equal(j.fidelity, undefined)
})

test('session pi inconnue : erreur habituelle, aucun signal', () => {
  assert.equal(sessionSlice(root, 'pi:00000000-0000-7000-8000-000000000000'), null)
  const r = run(['read', 'pi:00000000-0000-7000-8000-000000000000'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /session inconnue/)
  assert.ok(!/fidélité pi/.test(r.stdout + r.stderr))
})
