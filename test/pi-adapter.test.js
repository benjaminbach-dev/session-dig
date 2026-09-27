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
    messageLine(T0 + 4000, { role: 'bashExecution', command: 'git status', output: 'On branch main\n', exitCode: 0, cancelled: false, truncated: false, timestamp: T0 + 3500 }),
    JSON.stringify({ type: 'model_change', id: 'mc1', parentId: null, timestamp: new Date(T0 + 5000).toISOString(), provider: 'antho', modelId: 'sonnet-x' })
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

after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

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
  // métriques de session = somme des usage des messages (user → zéros)
  assert.deepEqual(a.tokens, { in: 900, out: 300, reasoning: 10, cacheRead: 5, cacheWrite: 7 })
  assert.equal(a.cost, 0.004)
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
  assert.equal(call.exitCode, undefined, 'exitCode omis : la source ne l expose pas sur toolResult')
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
  assert.equal(withRaw.length, 1, 'un seul rattachement')
  assert.equal(withRaw[0].toolCalls[0].cmd, 'echo le plus recent')
  assert.equal(withRaw[0].toolCalls[0].exitCode, 0)
  const partId = withRaw[0].toolCalls[0].rawRef
  assert.equal(partId, `pi:${withRaw[0].sessionId.slice(3)}:b2`)
  const raw = f.rawOutputs.find(x => x.id === partId)
  assert.equal(raw.content, 'le plus recent\n')
  // l'autre appel (b1) reste sans preuve : compté, jamais de rawRef inventé
  const b1 = f.events.flatMap(e => e.toolCalls || []).find(c => c.cmd === 'echo ancien')
  assert.ok(b1)
  assert.equal(b1.rawRef, undefined)
  assert.ok(r.ignored['call:bash-sans-preuve'] >= 1, 'appel sans preuve compté')
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
    messageLine(T0 + 10, { role: 'toolResult', toolCallId: 'ghost', toolName: 'bash', content: [text('resulat sans appel\n')], timestamp: T0 + 20 }, 'trorph1')
  ])
  const batches = []
  const r = adaptPi(tmp, {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  // partId qualifié par l'id de LIGNE d'enveloppe (pas le toolCallId)
  const partId = `pi:${s}:trorph1`
  const raw = f.rawOutputs.find(x => x.id === partId)
  assert.ok(raw, 'preuve toolResult orpheline écrite')
  assert.ok(r.orphans.includes(partId), 'partId répertorié dans orphans')
  assert.equal(raw.content, 'resulat sans appel\n')
  const refs = f.events.flatMap(e => (e.toolCalls || []).map(c => c.rawRef)).filter(Boolean)
  assert.ok(!refs.includes(partId), 'aucun rawRef inventé')
  assert.ok(r.ignored['orphan:toolResult'] >= 1, 'orphelin compté')
})

test('types ignorés __proto__ et constructor : comptés, zéro pollution de prototype', () => {
  const s = fakeUuid()
  const dir = path.join(tmp, 'proto')
  fs.mkdirSync(dir, { recursive: true })
  const junk = (type) => JSON.stringify({ type, id: 'j' + Math.random().toString(16).slice(2, 6), timestamp: new Date(T0).toISOString() })
  fs.writeFileSync(path.join(dir, 'ses.jsonl'), [
    sessionLine(s, T0, '/root/proto'),
    junk('__proto__'), junk('__proto__'), junk('constructor'), junk('constructor'), junk('constructor')
  ].join('\n') + '\n')
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  assert.equal(r.ignored['__proto__'], 2, '__proto__ compté avec le bon nombre')
  assert.equal(r.ignored['constructor'], 3, 'constructor compté avec le bon nombre')
  assert.equal(Object.getPrototypeOf(r.ignored), null, 'comptes sur objet à prototype nul')
  assert.equal(Object.keys(r.ignored).length, 2, 'deux types propres, aucune fuite ailleurs')
  assert.equal(({}).constructor, Object, 'aucune pollution globale')
})

test('type inconnu et types ignorés v0 : comptés dans ignored', () => {
  const { r } = collectAll({})
  assert.equal(r.ignored.podcast_drop, 1) // type inconnu (session C)
  assert.equal(r.ignored.model_change, 1) // type connu ignoré (session A)
  assert.equal(r.ignored['role:system'], undefined, 'aucun rôle system dans la fixture principale')
})

// ═════════ Ordre / regroupement ═════════

test('batches : événements groupés par session (contigus), sessions ordre croissant', () => {
  const { batches } = collectAll({})
  const seen = []
  for (const b of batches) {
    let prev = null
    for (const e of b.events) {
      if (e.sessionId !== prev) {
        assert.ok(!seen.includes(e.sessionId), 'une session ne réapparaît jamais après une autre')
        seen.push(e.sessionId)
        prev = e.sessionId
      }
    }
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

test('titre : session_info sans user → le name ; rien du tout → null', () => {
  const { batches } = collectAll({})
  const c = flat(batches).sessions.find(s => s.directory === '/root/grp-c')
  assert.ok(c)
  assert.equal(c.title, 'Titre explicite C')
  // session sans session_info ni message user : null
  const s = fakeUuid()
  writePiSession(tmp, 'notit', 'ses_notit.jsonl', [
    sessionLine(s, T0, '/root/notit'),
    messageLine(T0 + 1, { role: 'assistant', content: [text('assistant seul')] })
  ])
  const batches2 = []
  adaptPi(tmp, {}, {}, (b) => batches2.push(b))
  const ses = flat(batches2).sessions.find(x => x.id === `pi:${s}`)
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
  assert.equal(Object.keys(second.r.ignored).length, 0, 'aucun type ignoré')
  assert.deepEqual(second.r.files, s1.files, 'état inchangé (uuids compris)')
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

// ═════════ Relecture 27/09 — bloquants 1 à 11 ═════════
//
// Chaque test de cette section utilise son propre répertoire (mk) : les autres
// écrivent des fixtures INVALIDES dans tmp (échecs attendus) et pollueraient
// un parcours partagé.

const mk = (name) => path.join(tmp, 'rv-' + name)

test('fichier disparu : clé retirée de files (état depuis les fichiers présents)', () => {
  writePiSession(dstate, 'gone', 'ses_gone.jsonl', [
    sessionLine(fakeUuid(), T0, '/root/gone'),
    messageLine(T0 + 1, { role: 'user', content: [text('session vouee a disparaitre')] })
  ])
  const before = statePass(s1).r
  const rel = Object.keys(before.files).find(k => k.includes('ses_gone.jsonl'))
  assert.ok(rel, 'fichier suivi après 1re passe')
  fs.rmSync(path.join(dstate, 'gone'), { recursive: true, force: true })
  const { r, batches } = statePass(before)
  assert.equal(batches.length, 0, 'fichier disparu : rien à relire')
  assert.equal(r.files[rel], undefined, 'clé absente de files')
  assert.ok(Object.keys(r.files).includes('proj/ses.jsonl'), 'les autres fichiers restent suivis')
  s1 = r
})

test('rattaché sans sortie : ni rawRef ni preuve, attachement quand même effectif', () => {
  const s = fakeUuid()
  const dir = mk('nosort')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/nosort'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('ns1', 'bash', { command: 'echo absent' })] }),
    // toolResult SANS champ content : attaché (autoritaire) mais aucune sortie
    messageLine(T0 + 2, { role: 'toolResult', toolCallId: 'ns1', toolName: 'bash', isError: false, timestamp: T0 + 3 })
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  const call = f.events.flatMap(e => e.toolCalls || []).find(c => c.cmd === 'echo absent')
  assert.ok(call, 'appel présent')
  assert.equal(call.rawRef, undefined, 'aucun rawRef sans sortie')
  const partId = `pi:${s}:ns1`
  assert.equal(f.rawOutputs.some(x => x.id === partId), false, 'aucune preuve vide')
  assert.equal(r.orphans.includes(partId), false, 'l appel attaché n est pas un orphelin')
})

test('orphelin sans sortie : compté + listé dans orphans, aucune preuve', () => {
  const s = fakeUuid()
  const dir = mk('nosort-orph')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/nosort-orph'),
    messageLine(T0 + 1, { role: 'bashExecution', command: 'vide', timestamp: T0 + 2 }) // pas de champ output
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  assert.equal(f.rawOutputs.length, 0, 'aucune preuve émise')
  const partId = r.orphans.find(x => x.startsWith(`pi:${s}:`))
  assert.ok(partId, 'partId listé dans orphans (sans preuve)')
  assert.ok(r.ignored['orphan:bashExecution'] >= 1, 'orphelin compté')
})

test('appel bash sans résultat en fin de fichier : compté, sans rawRef ni preuve', () => {
  const s = fakeUuid()
  const dir = mk('sansres')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/sansres'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('sr1', 'bash', { command: 'jamais resu' })] }),
    messageLine(T0 + 2, { role: 'user', content: [text('suite sans résultat')] })
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  const call = f.events.flatMap(e => e.toolCalls || []).find(c => c.cmd === 'jamais resu')
  assert.ok(call)
  assert.equal(call.rawRef, undefined, 'jamais de rawRef inventé')
  assert.equal(f.rawOutputs.length, 0, 'aucune preuve')
  assert.ok(r.ignored['call:bash-sans-preuve'] >= 1, 'compté comme appel sans preuve')
})

test('bashExecution rattaché puis toolResult tardif du même appel : le toolResult gagne', () => {
  const s = fakeUuid()
  const dir = mk('departage')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/departage'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('d1', 'bash', { command: 'echo conflit' })] }),
    messageLine(T0 + 2, { role: 'bashExecution', command: 'echo provisoire', output: 'sortie bash\n', exitCode: 3, timestamp: T0 + 3 }),
    messageLine(T0 + 4, { role: 'toolResult', toolCallId: 'd1', toolName: 'bash', content: [text('sortie autoritaire\n')], timestamp: T0 + 5 })
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  const call = f.events.flatMap(e => e.toolCalls || []).find(c => c.cmd === 'echo conflit' || c.cmd === 'echo provisoire')
  assert.ok(call, 'appel présent')
  const partId = `pi:${s}:d1`
  assert.equal(call.rawRef, partId, 'le partId de l appel reçoit la sortie du toolResult')
  const raw = f.rawOutputs.find(x => x.id === partId)
  assert.ok(raw, 'preuve de l appel')
  assert.equal(raw.content, 'sortie autoritaire\n', 'sortie du toolResult, jamais écrasée')
  // la sortie du bashExecution devient orpheline sous SON id de ligne
  const orphan = f.rawOutputs.find(x => x.content === 'sortie bash\n')
  assert.ok(orphan, 'sortie bash conservée en orphelin')
  assert.ok(orphan.id.startsWith(`pi:${s}:`), 'partId qualifié par session')
  assert.ok(!f.events.some(e => (e.toolCalls || []).some(c => c.rawRef === orphan.id)), 'non référencée par un événement')
  assert.ok(r.ignored['orphan:bashExecution'] >= 1, 'déplacement compté')
})

test('double toolResult du même appel : le premier fait foi, le second orphelin', () => {
  const s = fakeUuid()
  const dir = mk('double')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/double'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('x1', 'bash', { command: 'echo une fois' })] }),
    messageLine(T0 + 2, { role: 'toolResult', toolCallId: 'x1', toolName: 'bash', content: [text('premiere sortie\n')], timestamp: T0 + 3 }),
    messageLine(T0 + 4, { role: 'toolResult', toolCallId: 'x1', toolName: 'bash', content: [text('seconde sortie\n')], timestamp: T0 + 5 })
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  const f = flat(batches)
  const raws = f.rawOutputs.filter(x => x.id === `pi:${s}:x1`)
  assert.equal(raws.length, 1, 'le partId de l appel n est jamais écrasé')
  assert.equal(raws[0].content, 'premiere sortie\n')
  const second = f.rawOutputs.find(x => x.content === 'seconde sortie\n')
  assert.ok(second, 'le second toolResult devient orphelin (avec sa preuve)')
  assert.ok(second.id !== `pi:${s}:x1`, 'sous son propre id de ligne')
  assert.ok(r.ignored['orphan:toolResult'] >= 1, 'compté orphelin')
})

test('ordre canonique : événements triés par (ts, id), départage par id à ts égal', () => {
  const s = fakeUuid()
  const dir = mk('ordre')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/ordre'),
    // timestamps inversés entre lignes + doublon de ts avec ids inversés
    messageLine(T0 + 200, { role: 'user', content: [text('B plus tard en ts, avant en fichier')], timestamp: T0 + 200 }, 'zzzz0002'),
    messageLine(T0 + 100, { role: 'assistant', content: [text('A plus tot en ts, après en fichier')], timestamp: T0 + 100 }, 'zzzz0001'),
    messageLine(T0 + 300, { role: 'user', content: [text('C ts égal à D, id après')], timestamp: T0 + 300 }, 'aaaa0002'),
    messageLine(T0 + 300, { role: 'assistant', content: [text('D ts égal à C, id avant')], timestamp: T0 + 300 }, 'aaaa0001')
  ])
  const batches = []
  adaptPi(dir, {}, {}, (b) => batches.push(b))
  const evs = flat(batches).events.filter(e => e.sessionId === `pi:${s}`)
  // ids d'événement QUALIFIÉS par session (D1 amendé) : pi:<uuid>:<id de ligne>
  assert.deepEqual(evs.map(e => e.id), [
    `pi:${s}:zzzz0001`, `pi:${s}:zzzz0002`, `pi:${s}:aaaa0001`, `pi:${s}:aaaa0002`
  ], 'tri (ts, id) indépendant de l ordre des lignes')
})

test('ni message.timestamp ni timestamp d enveloppe : échec explicite', () => {
  const s = fakeUuid()
  const dir = mk('sans-horloge')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'ses.jsonl'), [
    sessionLine(s, T0, '/root/sans-horloge'),
    JSON.stringify({ type: 'message', id: 'mh1', parentId: null, message: { role: 'user', content: [text('sans aucune horloge')] } })
  ].join('\n') + '\n')
  assert.throws(
    () => adaptPi(dir, {}, {}, () => {}),
    (e) => e.message.includes('ses.jsonl') && /:2:/.test(e.message) && /horloge/.test(e.message),
    'échec nommant fichier et ligne — jamais un ts null publié'
  )
})

test('émission au fil de l eau : un lot par session, ordre croissant, pas de batches en retour', () => {
  const dir = mk('flux')
  const ids = [fakeUuid(), fakeUuid(), fakeUuid()].sort()
  ids.forEach((id, i) => {
    writePiSession(dir, `s${i}`, 'ses.jsonl', [
      sessionLine(id, T0 + i, `/root/flux${i}`),
      messageLine(T0 + i, { role: 'user', content: [text(`flux ${i}`)] })
    ])
  })
  const received = []
  const r = adaptPi(dir, {}, {}, (b) => received.push(b))
  assert.equal(r.batches, undefined, 'batches absent du retour quand onBatch est fourni')
  assert.equal(received.length, 3, 'un lot par session')
  const seenIds = received.map(b => b.sessions[0].id)
  assert.deepEqual(seenIds, [...seenIds].sort(), 'ordre sessionId croissant')
  assert.ok(received.every(b => b.events.every(e => e.sessionId === b.events[0].sessionId)), 'une session par lot')
  // chemin sans callback : batches retournés (commodité de test)
  const noCb = adaptPi(dir, {}, {})
  assert.ok(Array.isArray(noCb.batches) && noCb.batches.length === 3)
})

test('métriques de session : somme exacte des usage de 2 assistants facturés', () => {
  const s = fakeUuid()
  const dir = mk('metriques')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/metriques'),
    messageLine(T0 + 1, { role: 'assistant', content: [text('un')], provider: 'p', model: 'm', usage: { input: 100, output: 50, reasoning: 5, cacheRead: 10, cacheWrite: 20, cost: { total: 0.001 } } }),
    messageLine(T0 + 2, { role: 'user', content: [text('entre deux')] }),
    messageLine(T0 + 3, { role: 'assistant', content: [text('deux')], provider: 'p', model: 'm', usage: { input: 200, output: 25, reasoning: 0, cacheRead: 0, cacheWrite: 5, cost: { total: 0.002 } } })
  ])
  const batches = []
  adaptPi(dir, {}, {}, (b) => batches.push(b))
  const ses = flat(batches).sessions.find(x => x.id === `pi:${s}`)
  assert.deepEqual(ses.tokens, { in: 300, out: 75, reasoning: 5, cacheRead: 10, cacheWrite: 25 })
  assert.ok(Math.abs(ses.cost - 0.003) < 1e-12, 'coût sommé')
})

test('ligne terminée vide : échec explicite (seule la ligne finale non terminée est tolérée)', () => {
  const dir = mk('ligne-vide')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'ses.jsonl'), [
    sessionLine(fakeUuid(), T0, '/root/ligne-vide'),
    '',
    messageLine(T0 + 1, { role: 'user', content: [text('après une ligne vide')] })
  ].join('\n') + '\n')
  assert.throws(
    () => adaptPi(dir, {}, {}, () => {}),
    (e) => e.message.includes('ses.jsonl') && /:2:/.test(e.message) && /vide/.test(e.message)
  )
})

test('fichier session_info : toutes les lignes terminées validées, aucun objet produit', () => {
  const dir = mk('titseul')
  // cas valide : consommé, aucun objet, acquit normal
  writePiSession(dir, 'd', 'ok.jsonl', [
    infoLine(T0, 'Titre seul A'),
    infoLine(T0 + 1, 'Titre seul B', 'i2')
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  assert.ok(!flat(batches).sessions.some(x => x.title && x.title.startsWith('Titre seul')), 'aucune session produite')
  assert.ok(r.files['d/ok.jsonl'], 'fichier suivi (validé et acquitté)')
  // cas invalide : l échec porte sur la ligne fautive, pas d abandon silencieux
  writePiSession(dir, 'bad', 'ses.jsonl', [
    infoLine(T0, 'Titre seul'),
    '{JSON SPILE'
  ])
  assert.throws(
    () => adaptPi(dir, {}, {}, () => {}),
    (e) => e.message.includes('ses.jsonl') && /:2:/.test(e.message) && /JSON invalide/.test(e.message),
    'la validation continue après un en-tête non-session'
  )
})

test('en-tête + session_info sans aucun message : la session est produite quand même', () => {
  const s = fakeUuid()
  const dir = mk('vide-info')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/vide-info'),
    infoLine(T0 + 1, 'Titre sans messages', 'vi1')
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  const ses = flat(batches).sessions.find(x => x.id === `pi:${s}`)
  assert.ok(ses, 'session produite')
  assert.equal(ses.title, 'Titre sans messages')
  assert.deepEqual(ses.tokens, { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  const evs = flat(batches).events.filter(e => e.sessionId === ses.id)
  assert.equal(evs.length, 0, 'aucun événement')
})

test('ids sûrs : séparateur de chemin rejeté, collision locale rejetée', () => {
  // uuid de session avec séparateur → échec ligne 1
  const d1 = mk('id-uuid')
  fs.mkdirSync(d1, { recursive: true })
  fs.writeFileSync(path.join(d1, 'ses.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'aa../../bb', timestamp: new Date(T0).toISOString(), cwd: '/root/x' }) + '\n')
  assert.throws(() => adaptPi(d1, {}, {}, () => {}), (e) => /:1:/.test(e.message) && /id invalide/.test(e.message))
  // id d'appel avec séparateur → échec sur la ligne de l appel
  const d2 = mk('id-call')
  fs.mkdirSync(d2, { recursive: true })
  fs.writeFileSync(path.join(d2, 'ses.jsonl'), [
    sessionLine(fakeUuid(), T0, '/root/x'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('c../../1', 'bash', { command: 'x' })] })
  ].join('\n') + '\n')
  assert.throws(() => adaptPi(d2, {}, {}, () => {}), (e) => /:2:/.test(e.message) && /appel invalide/.test(e.message))
  // collision : deux appels de même id dans le fichier → échec
  const d3 = mk('id-dup-call')
  fs.mkdirSync(d3, { recursive: true })
  fs.writeFileSync(path.join(d3, 'ses.jsonl'), [
    sessionLine(fakeUuid(), T0, '/root/x'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('dup', 'bash', {})] }),
    messageLine(T0 + 2, { role: 'assistant', content: [toolCallP('dup', 'bash', {})] })
  ].join('\n') + '\n')
  assert.throws(() => adaptPi(d3, {}, {}, () => {}), (e) => /:3:/.test(e.message) && /collision/.test(e.message))
  // collision : id de ligne d'enveloppe dupliqué → échec
  const d4 = mk('id-dup-line')
  fs.mkdirSync(d4, { recursive: true })
  fs.writeFileSync(path.join(d4, 'ses.jsonl'), [
    sessionLine(fakeUuid(), T0, '/root/x'),
    messageLine(T0 + 1, { role: 'user', content: [text('a')] }, 'sameid'),
    messageLine(T0 + 2, { role: 'user', content: [text('b')] }, 'sameid')
  ].join('\n') + '\n')
  assert.throws(() => adaptPi(d4, {}, {}, () => {}), (e) => /:3:/.test(e.message) && /collision/.test(e.message))
})

test('titre : premier texte user dont la première ligne est vide → null (strict)', () => {
  const s = fakeUuid()
  const dir = mk('titvide')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/titvide'),
    messageLine(T0 + 1, { role: 'user', content: [text('\nla première ligne est vide\npuis du texte')] })
  ])
  const batches = []
  adaptPi(dir, {}, {}, (b) => batches.push(b))
  const ses = flat(batches).sessions.find(x => x.id === `pi:${s}`)
  assert.ok(ses)
  assert.equal(ses.title, null, 'première ligne vide → null, pas une chaîne vide')
})

test('source absente vs illisible : messages distincts (pas de silence)', () => {
  assert.throws(() => adaptPi(path.join(mk('absent'), 'rien'), {}, {}, () => {}),
    (e) => /introuvable/.test(e.message))
  // un FICHIER à la place du répertoire : échec explicite, pas un parcours vide
  const dfile = mk('pas-un-rep')
  fs.writeFileSync(dfile, 'x')
  assert.throws(() => adaptPi(dfile, {}, {}, () => {}), (e) => /pas un répertoire/.test(e.message))
})

// ═════════ Seconde relecture — fixes 1 à 4 ═════════

test("ids sûrs : '\\' et ':' refusés sur les trois familles d'ids, blancs en bord refusés", () => {
  const mkCase = (name, buildLine) => {
    const dir = mk('safe2-' + name)
    fs.mkdirSync(dir, { recursive: true })
    const lines = [sessionLine(fakeUuid(), T0, '/root/x')]
    lines.push(buildLine())
    fs.writeFileSync(path.join(dir, 'ses.jsonl'), lines.join('\n') + '\n')
    return dir
  }
  const badIds = ['a\\b', 'a:b', ' id ', 'id ', '..x']
  for (const bad of badIds) {
    // id de session (ligne 1)
    const d1 = mk('safe2-ses-' + JSON.stringify(bad))
    fs.mkdirSync(d1, { recursive: true })
    fs.writeFileSync(path.join(d1, 'ses.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: bad, timestamp: new Date(T0).toISOString(), cwd: '/root/x' }) + '\n')
    assert.throws(() => adaptPi(d1, {}, {}, () => {}),
      (e) => /:1:/.test(e.message) && /id invalide/.test(e.message), `session id ${JSON.stringify(bad)}`)
    // id d'appel
    const d2 = mkCase('call-' + JSON.stringify(bad), () =>
      messageLine(T0 + 1, { role: 'assistant', content: [toolCallP(bad, 'bash', { command: 'x' })] }))
    assert.throws(() => adaptPi(d2, {}, {}, () => {}),
      (e) => /:2:/.test(e.message) && /appel invalide/.test(e.message), `call id ${JSON.stringify(bad)}`)
    // id de ligne d'enveloppe
    const d3 = mkCase('line-' + JSON.stringify(bad), () =>
      messageLine(T0 + 1, { role: 'user', content: [text('x')] }, bad))
    assert.throws(() => adaptPi(d3, {}, {}, () => {}),
      (e) => /:2:/.test(e.message) && /id de ligne invalide/.test(e.message), `line id ${JSON.stringify(bad)}`)
  }
})

test("id d'appel contenant '|' : conservé littéralement (forme réelle)", () => {
  const s = fakeUuid()
  const dir = mk('safe-pipe')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/x'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('call_abc|fc_def', 'bash', { command: 'ok' })] }),
    messageLine(T0 + 2, { role: 'toolResult', toolCallId: 'call_abc|fc_def', toolName: 'bash', content: [text('sortie\n')], timestamp: T0 + 3 })
  ])
  const batches = []
  const r = adaptPi(dir, {}, {}, (b) => batches.push(b))
  const call = flat(batches).events.flatMap(e => e.toolCalls || [])[0]
  assert.equal(call.rawRef, `pi:${s}:call_abc|fc_def`, 'partId avec | intact')
  assert.ok(r.orphans.length === 0, 'rattaché sans orphelin')
})

test('invariant un-UUID-un-fichier : deux fichiers, même UUID → échec avec les deux chemins', () => {
  const dir = mk('dup-uuid')
  const s = fakeUuid() // MÊME uuid dans deux fichiers
  writePiSession(dir, 'a', 'ses_a.jsonl', [
    sessionLine(s, T0, '/root/dup-a'),
    messageLine(T0 + 1, { role: 'user', content: [text('depuis le fichier a')] })
  ])
  writePiSession(dir, 'b', 'ses_b.jsonl', [
    sessionLine(s, T0, '/root/dup-b'),
    messageLine(T0 + 2, { role: 'user', content: [text('depuis le fichier b')] })
  ])
  assert.throws(
    () => adaptPi(dir, {}, {}, () => {}),
    (e) =>
      e.message.includes('ses_a.jsonl') && e.message.includes('ses_b.jsonl') &&
      e.message.includes(s) && /un-UUID-un-fichier/.test(e.message),
    'échec nommant les deux chemins et le UUID — pas de fusion partielle'
  )
})

test('toolResult avec exitCode exposé : porté sur l événement de l appel', () => {
  const s = fakeUuid()
  const dir = mk('tr-exitcode')
  writePiSession(dir, 'd', 'ses.jsonl', [
    sessionLine(s, T0, '/root/tr-exitcode'),
    messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('ec1', 'bash', { command: 'echo code' })] }),
    messageLine(T0 + 2, { role: 'toolResult', toolCallId: 'ec1', toolName: 'bash', content: [text('ok\n')], exitCode: 7, timestamp: T0 + 3 })
  ])
  const batches = []
  adaptPi(dir, {}, {}, (b) => batches.push(b))
  const call = flat(batches).events.flatMap(e => e.toolCalls || [])[0]
  assert.equal(call.exitCode, 7, 'exitCode du toolResult porté sur l appel')
  assert.equal(call.rawRef, `pi:${s}:ec1`)
})

test('session > batchSize : chaque événement une fois, ordre (ts,id), session et preuves au premier lot', () => {
  const s = fakeUuid()
  const dir = mk('grosse')
  const N = 7
  const lines = [sessionLine(s, T0, '/root/grosse')]
  // 2 preuves rattachées + N événements, ts croissants mais lignes en désordre
  lines.push(messageLine(T0 + 1, { role: 'assistant', content: [toolCallP('g1', 'bash', { command: 'cmd1' })] }))
  lines.push(messageLine(T0 + 2, { role: 'toolResult', toolCallId: 'g1', toolName: 'bash', content: [text('sortie g1\n')], timestamp: T0 + 2 }))
  for (let i = N; i >= 1; i--) {
    lines.push(messageLine(T0 + 10 + (N - i) * 10, { role: 'user', content: [text(`msg ${i}`)], timestamp: T0 + 10 + i }))
  }
  writePiSession(dir, 'd', 'ses.jsonl', lines)
  const received = []
  const r = adaptPi(dir, {}, { batchSize: 2 }, (b) => received.push(b))
  const all = received.flatMap(b => b.events)
  // header + assistant + toolResult (résultat, PAS un événement) + N users → N+1 événements
  assert.equal(all.length, N + 1, 'chaque événement arrive exactement une fois')
  assert.equal(new Set(all.map(e => e.id)).size, all.length, 'aucun doublon')
  const sorted = [...all].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  assert.deepEqual(all.map(e => e.id), sorted.map(e => e.id), 'ordre (ts, id) global à travers la découpe')
  // session + preuve rattachée dans le PREMIER lot (découpe au fil des événements)
  assert.equal(received[0].sessions.length, 1, 'session publiée dans le premier lot')
  assert.equal(received[0].rawOutputs.length, 1, 'preuve rattachée dans le premier lot')
  assert.ok(received.slice(1).every(b => b.sessions.length === 0), 'session jamais republiée')
  assert.equal(received[0].events.length, 2, `découpe à batchSize=2 (${received[0].events.length})`)
  // l'état/les orphelins restent corrects
  assert.equal(r.orphans.length, 0)
  assert.equal(Object.keys(r.files).length, 1)
})
