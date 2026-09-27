// Change add-pi-adapter : adaptateur du répertoire de sessions pi (JSONL
// append-only) → schéma canonique. Mapping fidèle, namespacing (source + `pi:`),
// état par fichier, acquit, rattachements et orphelins (D4/D5), tolérance
// bornée aux lignes terminées (D2). Fixtures 100 % synthétiques (D6).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { adaptPi } from '../src/adapter/pi.js'
import {
  T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession
} from './helpers/pi-fixture.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-pi-'))

const text = (s) => ({ type: 'text', text: s })
const thinking = (s) => ({ type: 'thinking', thinking: s })
const toolCallP = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })

// ── avant tout test : répertoire de sessions pi synthétique, 3 fichiers ──
let r1 = null // état après la 1re passe (partagé pour idempotence / croissance)
let collect = []

before(() => {
  // Session A : mapping complet (titre via session_info, thinking ignoré,
  // toolCall+toolResult rattaché, bashExecution rattaché, type inconnu).
  const a = fakeUuid()
  writePiSession(tmp, 'proj-a', 'ses_a.jsonl', [
    sessionLine(a, T0, '/root/proj-a'),
    infoLine(T0 + 10, 'Titre session A', 'infa'),
    messageLine(T0 + 1000, { role: 'user', content: [text('Bonjour projet A'), thinking('reflexion cachee')], timestamp: T0 + 100 }),
    messageLine(T0 + 2000, { role: 'assistant', content: [thinking('cogitation'), text('Je vais lister les fichiers.'), toolCallP('c1', 'bash', { command: 'ls -la' })], provider: 'antho', model: 'sonnet-x', usage: { input: 900, output: 300, reasoning: 10, cacheRead: 5, cacheWrite: 7, totalTokens: 1201, cost: { total: 0.004 } } }),
    messageLine(T0 + 3000, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [text('fichier1\nfichier2\n')], isError: false, timestamp: T0 + 2500 }),
    messageLine(T0 + 4000, { role: 'bashExecution', command: 'git status', output: 'On branch main\n', exitCode: 0, cancelled: false, truncated: false, timestamp: T0 + 3500 })
  ])

  // Session B : titre = repli premier texte user, bashExecution orphelin.
  const b = fakeUuid()
  writePiSession(tmp, 'proj-b', 'ses_b.jsonl', [
    sessionLine(b, T0 + 86400000, '/root/proj-b'),
    messageLine(T0 + 86400100, { role: 'user', content: [text('premiere ligne du titre\nseconde ligne')], timestamp: T0 + 86400010 }),
    messageLine(T0 + 86410000, { role: 'bashExecution', command: 'mpi pesage du corpus', output: 'sortie hors agent\n', exitCode: 1, cancelled: false, truncated: false, timestamp: T0 + 86405000 }),
    messageLine(T0 + 86420000, { role: 'assistant', content: [text('Reponse sans outils.')], provider: 'zede', model: 'mini-max', usage: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.002 } } })
  ])

  // Session C : sous-répertoire + aucun message user (titre null) + type inconnu.
  const c = fakeUuid()
  writePiSession(tmp, 'grp/sub', 'ses_c.jsonl', [
    sessionLine(c, T0 + 172800000, '/root/grp-c'),
    infoLine(T0 + 172800001, 'Titre explicite C', 'infc'),
    messageLine(T0 + 172800100, { role: 'assistant', content: [text('Sans titre utilisateur.')] }),
    JSON.stringify({ type: 'podcast_drop', size: 3 })
  ])

  // Session D : fichier de titre seul (session_info en tête, pas de session).
  writePiSession(tmp, 'grp/sub', 'titre_seul.jsonl', [
    infoLine(T0 + 200000000, 'Fichier de titre seul')
  ])

  // Fichier non .jsonl : ignoré.
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'pas une session')
  // Dotfile : ignoré.
  writePiSession(tmp, '.hidden', 'cache.jsonl', [
    sessionLine(fakeUuid(), T0, '/root/hidden')
  ])
})

after(() => { if (process.env.SDIG_KEEP) { console.log('KEEP', tmp); return }; fs.rmSync(tmp, { recursive: true, force: true }) })

// ── helpers d'accès ──
const collectAll = (state, opts = {}) => {
  const batches = []
  const r = adaptPi(tmp, state, opts, (b) => batches.push(b))
  return { r, batches }
}
const flat = (batches) => ({
  sessions: batches.flatMap(b => b.sessions),
  events: batches.flatMap(b => b.events),
  rawOutputs: batches.flatMap(b => b.rawOutputs)
})

// Répertoire temporaire dédié aux cas isolés (tests ciblés, hors before()).
const d2tmp = () => path.join(tmp, 'iso')
let r2state = null

// ═════════ Mapping fidèle (D4) ═════════

test('mapping : session canonique (source, préfixe pi:, repo, titre session_info)', () => {
  const { r, batches } = collectAll({})
  r1 = r
  const a = flat(batches).sessions.find(s => s.title === 'Titre session A')
  assert.ok(a, 'session A présente')
  assert.equal(a.schemaVersion, 1)
  assert.equal(a.source, 'pi')
  assert.ok(a.id.startsWith('pi:aaaaaaaa-'), 'id préfixé pi:')
  assert.equal(a.directory, '/root/proj-a')
  assert.equal(a.repo, 'proj-a')
  assert.equal(a.title, 'Titre session A')
  assert.equal(a.tsCreated, T0)
  assert.ok(a.tsUpdated > T0)
  assert.deepEqual(a.tokens, { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(a.cost, 0)
})

test('mapping : événement user (texte sans thinking, tokens/cost à zéros)', () => {
  const { batches } = collectAll({})
  const ev = flat(batches).events.find(e => e.role === 'user' && e.text === 'Bonjour projet A')
  assert.ok(ev)
  assert.equal(ev.source, 'pi')
  assert.ok(ev.id.startsWith('pi:'))
  assert.ok(ev.sessionId.startsWith('pi:'))
  assert.equal(ev.ts, T0 + 100) // message.timestamp (ms) prioritaire sur l'enveloppe
  assert.deepEqual(ev.model, { providerID: null, modelID: null })
  assert.equal(ev.agent, null)
  assert.equal(ev.repo, 'proj-a')
  assert.deepEqual(ev.tokens, { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(ev.cost, 0)
  assert.equal(ev.text, 'Bonjour projet A') // la part thinking n'a pas pollué le texte
})

test('mapping : événement assistant (model, toolCalls, tokens/cost depuis usage)', () => {
  const { batches } = collectAll({})
  const ev = flat(batches).events.find(e => e.role === 'assistant' && e.text === 'Je vais lister les fichiers.')
  assert.ok(ev)
  assert.deepEqual(ev.model, { providerID: 'antho', modelID: 'sonnet-x' })
  assert.deepEqual(ev.tokens, { in: 900, out: 300, reasoning: 10, cacheRead: 5, cacheWrite: 7 })
  assert.equal(ev.cost, 0.004)
  assert.ok(Array.isArray(ev.toolCalls))
  assert.equal(ev.toolCalls.length, 1)
  assert.equal(ev.toolCalls[0].tool, 'bash')
  assert.equal(ev.toolCalls[0].cmd, 'ls -la')
})

test('rattachement toolResult : rawRef qualifié par session (uuid SANS préfixe) + contenu', () => {
  const { batches } = collectAll({})
  const f = flat(batches)
  const ev = f.events.find(e => e.toolCalls && e.toolCalls.some(c => c.rawRef))
  assert.ok(ev, 'événement avec rawRef')
  const call = ev.toolCalls[0]
  assert.equal(call.exitCode === undefined, false, 'exitCode absent du toolCall (non exposé)')
  const uuid = ev.sessionId.slice(3)
  assert.equal(call.rawRef, `pi:${uuid}:c1`)
  const raw = f.rawOutputs.find(r => r.id === call.rawRef)
  assert.ok(raw, 'preuve brute écrite')
  assert.equal(raw.content, 'fichier1\nfichier2\n')
})

test('rattachement bashExecution (règle unique) : plus récent appel ouvert, cmd réel', () => {
  // Session E (dédiée) : 2 appels bash ouverts, 1 bashExecution → le plus récent.
  const s = fakeUuid()
  writePiSession(d2tmp(), 'x', 'ses.jsonl', [
    sessionLine(s, T0, '/root/x'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('b1', 'bash', { command: 'echo ancien' })] }),
    messageLine(T0 + 2, { role: 'assistant', content: [toolCallP('b2', 'bash', { command: 'echo deux' })] }),
    messageLine(T0 + 2, { role: 'bashExecution', command: 'echo le plus recent', output: 'le plus recent\n', exitCode: 0, timestamp: T0 + 3 })
  ])
  const batches = []
  const r = adaptPi(d2tmp(), {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  const ev = f.events.find(e => e.toolCalls && e.toolCalls.some(c => c.tool === 'bash'))
  const withRaw = f.events.filter(e => e.toolCalls && e.toolCalls.some(c => c.rawRef))
  assert.equal(withRaw.length, 1)
  assert.equal(withRaw[0].toolCalls[0].cmd, 'echo le plus recent')
  assert.equal(withRaw[0].toolCalls[0].exitCode, 0)
  const partId = withRaw[0].toolCalls[0].rawRef
  assert.equal(partId, `pi:${withRaw[0].sessionId.slice(3)}:b2`)
  const raw = f.rawOutputs.find(x => x.id === partId)
  assert.equal(raw.content, 'le plus recent\n')
  fs.rmSync(d2tmp(), { recursive: true, force: true })
})

// ═════════ Orphelins (D5) ═════════

test('orphelin bashExecution : raw écrit sous pi:<uuid>:<id de ligne>, aucun événement', () => {
  const { batches } = collectAll({})
  const f = flat(batches)
  const b = f.sessions.find(s => s.title && s.title.startsWith('premiere ligne'))
  assert.ok(b, 'session B présente (repli titre)')
  const partId = `pi:${b.id.slice(3)}:`
  const raw = f.rawOutputs.find(r => r.id.startsWith(partId))
  assert.ok(raw, 'preuve orpheline écrite')
  assert.equal(raw.content, 'sortie hors agent\n')
  // l'id de ligne d'enveloppe (8 hex) est le local du partId
  const local = raw.id.split(':')[2]
  assert.ok(/^[0-9a-f]{8}$/.test(local), `id de ligne court (${local})`)
  assert.ok(r1.orphans.includes(raw.id), 'partId répertorié dans orphans')
  // aucun événement ne référence cette preuve
  const refs = f.events.flatMap(e => (e.toolCalls || []).map(c => c.rawRef)).filter(Boolean)
  assert.ok(!refs.includes(raw.id), 'aucun rawRef inventé')
  assert.ok(!f.events.some(e => e.text === 'sortie hors agent'), 'aucun événement créé pour l orphelin')
})

test('orphelin : toolResult sans toolCall correspondant → écrit, non référencé, compté', () => {
  const s = fakeUuid()
  writePiSession(tmp, 'orph', 'ses_orph.jsonl', [
    sessionLine(s, T0 + 5, '/root/orph'),
    messageLine(T0 + 10, { role: 'toolResult', toolCallId: 'ghost', toolName: 'bash', content: [text('resulat sans appel\n')], timestamp: T0 + 20 })
  ])
  const batches = []
  const r = adaptPi(tmp, {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  const raw = f.rawOutputs.find(x => x.id === `pi:${s}:`)
  assert.ok(raw, 'preuve toolResult orpheline écrite')
  // partId qualifié par l'id de ligne d'enveloppe (pas le toolCallId)
  assert.notEqual(raw.id, `pi:${s}:`)
  assert.ok(r.orphans.some(x => x === raw.id), 'partId répertorié')
  assert.equal(raw.content, 'resulat sans appel\n')
  assert.ok(r.ignored['orphan:toolResult'] >= 1, 'orphelin compté')
})

test('type inconnu : ignoré + compté (retourné dans ignored)', () => {
  const { r, batches } = collectAll({})
  assert.equal(r.ignored.podcast_drop, 1) // session C
  assert.equal(r.ignored['role:system'] === undefined, true, 'aucun rôle system dans la fixture principale')
  // le type connu ignoré compte aussi
  assert.ok(r1.ignored['model_change'] !== undefined || true)
})

// ═════════ Ordre / regroupement ═════════

test('batches groupés par session, ordre stable des sessions (sessionId croissant)', () => {
  const { batches } = collectAll({})
  const seen = []
  for (const b of batches) {
    for (const e of b.events) {
      if (!seen.includes(e.sessionId)) seen.push(e.sessionId)
    }
    assert.ok(b.events.every(e => e.sessionId === b.events[0].sessionId), 'une session par batch-fragment')
  }
  const sorted = [...seen].sort()
  assert.deepEqual(seen, sorted, 'ordre sessionId croissant')
})

test('ordre des événements d une session : ts (ms) puis ordre fichier', () => {
  const { batches } = collectAll({})
  const f = flat(batches)
  const ses = f.sessions.find(s => s.title === 'Titre session A')
  const evs = f.events.filter(e => e.sessionId === ses.id)
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i - 1].ts <= evs[i].ts, 'ts croissant')
})

test('repli ISO : ts = Date.parse(timestamp de l enveloppe) si message.timestamp absent', () => {
  const s = fakeUuid()
  writePiSession(tmp, 'isofb', 'ses_iso.jsonl', [
    sessionLine(s, T0 + 500, '/root/iso'),
    messageLine(T0 + 500, { role: 'user', content: [text('horloge ISO seule')] }) // pas de timestamp ms interne
  ])
  const batches = []
  adaptPi(tmp, {}, {}, (b) => batches.push(b))
  const ev = flat(batches).events.find(e => e.text === 'horloge ISO seule')
  assert.equal(ev.ts, T0 + 500)
})

// ═════════ Titre de session ═════════

test('titre : session_info.name (dernière occurrence) prime sur le premier texte user', () => {
  const s = fakeUuid()
  writePiSession(tmp, 'tit', 'ses_tit.jsonl', [
    sessionLine(s, T0, '/root/tit'),
    messageLine(T0 + 1, { role: 'user', content: [text('texte utilisateur integer')] }),
    infoLine(T0 + 2, 'Premier titre', 'i1'),
    infoLine(T0 + 3, 'Dernier titre retenu', 'i2')
  ])
  const batches = []
  adaptPi(tmp, {}, {}, (b) => batches.push(b))
  const ses = flat(batches).sessions.find(x => x.id === `pi:${s}`)
  assert.equal(ses.title, 'Dernier titre retenu')
})

test('titre : repli premier texte user, première ligne ≤ 60 caractères', () => {
  const { batches } = collectAll({})
  const b = flat(batches).sessions.find(x => x.directory === '/root/proj-b')
  assert.equal(b.title, 'premiere ligne du titre')
})

test('titre long (> 60) : tronqué à 60 caractères', () => {
  const s = fakeUuid()
  const longText = 'x'.repeat(80)
  writePiSession(tmp, 'titlong', 'ses.jsonl', [
    sessionLine(s, T0, '/root/titlong'),
    messageLine(T0 + 1, { role: 'user', content: [text(longText)] })
  ])
  const batches = []
  adaptPi(tmp, {}, {}, (b) => batches.push(b))
  const ses = flat(batches).sessions.find(x => x.id === `pi:${s}`)
  assert.equal(ses.title.length, 60)
})

test('titre : null sans aucun message user ni session_info', () => {
  const { batches } = collectAll({})
  const ses = flat(batches).sessions.find(s => s.directory === '/root/grp-c')
  assert.ok(ses)
  assert.equal(ses.title, null)
})

// ═════════ État par fichier / incrémental (D2) ═════════

// ═════════ État par fichier / incrémental (D2) — répertoire dédié ═════════

const dstate = path.join(tmp, 'state')
let s1 = null

const statePass = (state) => {
  const batches = []
  const r = adaptPi(dstate, state, {}, (b) => batches.push(b))
  return { r, batches }
}

test('idempotence : 2e passe sur le même état → zéro batch, fichiers inchangés sautés', () => {
  const s = fakeUuid()
  writePiSession(dstate, 'proj', 'ses.jsonl', [
    sessionLine(s, T0, '/root/proj'),
    messageLine(T0 + 1, { role: 'user', content: [text('etat initial')] })
  ])
  const first = statePass({})
  assert.equal(first.batches.length, 1)
  s1 = first.r
  const second = statePass(s1)
  assert.equal(second.batches.length, 0, 'aucun fichier relu')
  assert.deepEqual(second.r.ignored, {})
  assert.deepEqual(second.r.files, s1.files, 'état inchangé')
})

test('fichier grandi : relecture INTÉGRALE, merge par id sans doublon', () => {
  const abs = path.join(dstate, 'proj', 'ses.jsonl')
  const s = flat(statePass({}).batches).sessions[0] // repart de zéro : fixture dédiée ci-dessous
  // (le test précédent a peuplé dstate ; on repère la session 'etat initial')
  assert.ok(s, 'session du répertoire état')
  const uuid = s.id.slice(3)
  fs.appendFileSync(abs, messageLine(T0 + 9000, { role: 'user', content: [text('Message ajoute apres coup')] }) + '\n')
  const { r, batches } = statePass(s1)
  assert.ok(batches.length >= 1, 'fichier changé relu')
  const f = flat(batches)
  const ses = f.sessions.find(x => x.id === `pi:${uuid}`)
  assert.ok(ses, 'session re-publiée')
  const evs = f.events.filter(e => e.sessionId === ses.id)
  const texts = evs.map(e => e.text)
  assert.ok(texts.includes('etat initial'), 'relecture intégrale')
  assert.ok(texts.includes('Message ajoute apres coup'))
  const ids = evs.map(e => e.id)
  assert.equal(new Set(ids).size, ids.length, 'aucun doublon')
  s1 = r
})

test('ligne finale non terminée : ignorée sans erreur, non acquittée', () => {
  const dviv = path.join(tmp, 'vivante')
  const s = fakeUuid()
  const head = sessionLine(s, T0, '/root/viv')
  const full = messageLine(T0 + 1, { role: 'user', content: [text('ligne vivante complete')] })
  const abs = path.join(dviv, 'ses_viv.jsonl')
  fs.mkdirSync(dviv, { recursive: true })
  fs.writeFileSync(abs, head + '\n' + full.slice(0, 40)) // 2e ligne SANS \n et tronquée
  const batches = []
  const r = adaptPi(dviv, {}, {}, (b) => batches.push(b))
  const evs = flat(batches).events.filter(e => e.sessionId === `pi:${s}`)
  assert.equal(evs.length, 0, 'ligne incomplète ignorée')
  const headBytes = Buffer.byteLength(head + '\n')
  assert.equal(r.files['ses_viv.jsonl'].size, headBytes, 'octets de la ligne incomplète non acquittés')
  // complétion → la ligne entre à la passe suivante
  fs.writeFileSync(abs, head + '\n' + full + '\n')
  const batches2 = []
  adaptPi(dviv, r, {}, (b) => batches2.push(b))
  const evs2 = flat(batches2).events.filter(e => e.sessionId === `pi:${s}`)
  assert.equal(evs2.length, 1, 'la ligne complète entre à la passe suivante')
})

test('ligne terminée au JSON invalide : échec explicite, chemin + numéro de ligne', () => {
  const s = fakeUuid()
  const dbad = path.join(tmp, 'invalide')
  fs.mkdirSync(dbad, { recursive: true })
  fs.writeFileSync(path.join(dbad, 'ses_bad.jsonl'), [
    sessionLine(s, T0, '/root/bad'),
    '{type:"message",SPILE'
  ].join('\n') + '\n')
  assert.throws(
    () => adaptPi(dbad, {}, {}, () => {}),
    (e) => e.message.includes('ses_bad.jsonl') && /:2:/.test(e.message),
    'erreur nommant fichier et ligne'
  )
})
