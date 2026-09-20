// Lecture du contexte + preuve (retour d'agent 16/09) : voisinage, fenêtres, raw.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest, loadCorpus } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { mergeWindows, sessionSlice, resolveAnchor, parseAnchorTimestamp } from '../src/read.js'
import { eventsBySession } from '../src/read-legacy.js'
import { openView } from '../src/view.js'
import { rawScan } from '../src/raw.js'
import { renderRead, renderTerminal } from '../src/format.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-read-'))
const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const indexPath = path.join(root, 'index.db')

before(async () => {
  buildFixtureDb(dbPath)
  await ingest({ root, db: dbPath })
  index(root, indexPath)
})
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

test('mergeWindows : fenêtres fusionnées et bornées', () => {
  // hits aux index 2 et 5, ctx 1 → [1,3] et [4,6] adjacentes → fusionnées (pas de trou)
  assert.deepEqual(mergeWindows(10, [2, 5], 1), [[1, 6]])
  // fenêtres disjointes (trou d'au moins 1 message) → conservées séparées
  assert.deepEqual(mergeWindows(10, [2, 6], 1), [[1, 3], [5, 7]])
  // bornes : hit 0 ctx 2 → [0,2]
  assert.deepEqual(mergeWindows(10, [0], 2), [[0, 2]])
})

test('sessionSlice : --around ressort la fenêtre et le message visé', () => {
  const slice = sessionSlice(root, 'ses_fix1', { aroundId: 'msg_a1', ctx: 1 })
  assert.ok(slice)
  assert.equal(slice.aroundIdx, 1) // u1, a1, a2 → a1 à l'index 1
  assert.deepEqual(slice.spans, [[0, 2]])
  const out = renderRead(slice, 'ses_fix1')
  assert.ok(out.includes('►')) // le message visé est marqué
  assert.ok(out.includes('461')) // voisin u1 visible
})

test('sessionSlice : session inconnue → null ; --tail borne la fin', () => {
  assert.equal(sessionSlice(root, 'ses_xxx', {}), null)
  const slice = sessionSlice(root, 'ses_fix1', { tail: 2 })
  assert.deepEqual(slice.spans, [[1, 2]])
})

test('recherche --ctx : les voisins du hit apparaissent, hits marqués ►', () => {
  const hits = search(indexPath, { q: 'timeout upstream', limit: 5, plain: true })
  const { events, sessionsById } = loadCorpus(root)
  const evs = eventsBySession(events)
  const out = renderTerminal(hits, sessionsById, { ctx: 1, eventsBySession: evs, plain: true })
  assert.ok(out.includes('►')) // hit marqué
  assert.ok(out.includes('461')) // voisin avant
  assert.ok(out.includes('Je relance')) // voisin après
  assert.ok(out.includes('git revert')) // cmd du toolCall visible dans le contexte
})

test('recherche --ctx : hits proches → fenêtre fusionnée, pas de doublon', () => {
  const hits = search(indexPath, { q: 'proxy timeout', limit: 5, plain: true })
  const { events, sessionsById } = loadCorpus(root)
  const evs = eventsBySession(events)
  const out = renderTerminal(hits, sessionsById, { ctx: 2, eventsBySession: evs, plain: true })
  // u1 rendu une seule fois (le titre de session contient aussi « 461 » — on compte le texte, pas le titre)
  assert.equal(out.split('renvoie').length - 1, 1)
  assert.equal(out.split('Je relance').length - 1, 1) // voisin a2 affiché une fois
})

test('rawScan : trouve une erreur qui n\'existe que dans la sortie brute', async () => {
  // ajouter une sortie brute avec stderr typique sur un nouveau message
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const t = Date.now()
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run('msg_err1', 'ses_fix1', t, t, JSON.stringify({ role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm' }))
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run('prt_err1', 'msg_err1', 'ses_fix1', t, t, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'go test ./...' }, output: 'FAIL: TestUpstream [stderr] connection refused 461\nexit status 1', metadata: { exitCode: 1 } } }))
  db.close()
  await ingest({ root, db: dbPath })
  index(root, indexPath)

  const hits = search(indexPath, { q: 'connection refused', limit: 5, plain: true })
  assert.equal(hits.length, 0) // pas dans l'index BM25 (spec : bruit exclu)
  const raw = rawScan(root, 'connection refused', { limit: 5 })
  assert.equal(raw.length, 1)
  assert.equal(raw[0].rawRef, 'prt_err1')
  assert.equal(raw[0].sessionId, 'ses_fix1')
  assert.ok(raw[0].line.includes('connection refused'))
  assert.equal(raw[0].tool, 'bash')
})

async function await_loadCorpus () {
  const { loadCorpus } = await import('../src/corpus.js')
  return loadCorpus(root)
}

// ── change add-read-at : ancrage temporel (masquage des messages postérieurs) ──

// Timeline dédiée : une question d'état, une réponse, puis une MUTATION (retrait d'un
// outil), puis la vérification. Les time_created sont fixes (reproductibles) ; les
// time_updated sont frais (le watermark d'ingestion avance, comme un vrai message modifié).
const A0 = Date.UTC(2026, 8, 10, 9, 0, 0) // 2026-09-10 09:00 UTC
const AT_TITLE = 'Permissions de l\'agent explore'

before(async () => {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath)
  const fresh = Date.now()
  db.prepare(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('ses_at1', null, '/root/ks-agent', AT_TITLE, A0, fresh, 0, 10, 10, 0)
  const msg = (id, ts, data) => db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run(id, 'ses_at1', ts, fresh, JSON.stringify(data))
  const part = (id, msgId, ts, data) => db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run(id, msgId, 'ses_at1', ts, fresh, JSON.stringify(data))
  msg('msg_at1q', A0, { role: 'user', agent: 'build', model: { providerID: 'opencode-go', modelID: 'glm-5.2' } })
  part('prt_at1q', 'msg_at1q', A0, { type: 'text', text: 'quels outils a l\'agent explore ?' })
  msg('msg_at1a', A0 + 60000, { role: 'assistant', agent: 'build', model: { providerID: 'opencode-go', modelID: 'glm-5.2' } })
  part('prt_at1a', 'msg_at1a', A0 + 60000, { type: 'text', text: 'explore a l\'outil bash autorisé (permission bash allow dans opencode.json)' })
  msg('msg_at1mut', A0 + 120000, { role: 'user', agent: 'build', model: { providerID: 'opencode-go', modelID: 'glm-5.2' } })
  part('prt_at1mut', 'msg_at1mut', A0 + 120000, { type: 'text', text: 'Retire le bash d\'explore, il ne doit plus exécuter de commandes' })
  msg('msg_at1b', A0 + 180000, { role: 'assistant', agent: 'build', model: { providerID: 'opencode-go', modelID: 'glm-5.2' } })
  part('prt_at1b', 'msg_at1b', A0 + 180000, { type: 'text', text: 'C\'est fait : permission bash = deny pour explore' })
  msg('msg_at1c', A0 + 240000, { role: 'assistant', agent: 'build', model: { providerID: 'opencode-go', modelID: 'glm-5.2' } })
  part('prt_at1c', 'msg_at1c', A0 + 240000, { type: 'text', text: 'Vérifié : explore n\'a plus bash' })
  db.close()
  await ingest({ root, db: dbPath })
  index(root, indexPath)
})

test('--at <msgId> : les messages postérieurs sont masqués, l\'ancre et le compte sont dits', () => {
  const slice = sessionSlice(root, 'ses_at1', { at: 'msg_at1mut' })
  assert.equal(slice.maxIdx, 2) // q1, a1, mut visibles
  assert.equal(slice.maskedCount, 2) // a2, a3 masqués
  assert.equal(slice.anchor.id, 'msg_at1mut')
  assert.deepEqual(slice.spans, [[0, 2]])
  const out = renderRead(slice, 'ses_at1', { plain: true })
  assert.ok(out.includes('ancre : msg_at1mut'))
  assert.ok(out.includes('2 message(s) postérieur(s) à l\'ancre masqué(s)'))
  assert.ok(out.includes('sans --at')) // comment tout revoir
  assert.ok(out.includes('bash autorisé')) // l'état AVANT la mutation est lisible
  assert.ok(!out.includes('permission bash = deny')) // le message de mutation reste dehors
})

test('--at : sans ancre, la session entière reste visible (masquage non définitif)', () => {
  const slice = sessionSlice(root, 'ses_at1', {})
  assert.equal(slice.anchor, null)
  assert.equal(slice.maskedCount, 0)
  const out = renderRead(slice, 'ses_at1', { plain: true })
  assert.ok(out.includes('permission bash = deny'))
  assert.ok(!out.includes('masqué'))
})

test('--at : inclusion de l\'instant exact (le message de l\'ancre est visible)', () => {
  const slice = sessionSlice(root, 'ses_at1', { at: 'msg_at1a' })
  assert.equal(slice.maxIdx, 1)
  assert.equal(slice.maskedCount, 3)
  const out = renderRead(slice, 'ses_at1', { plain: true })
  assert.ok(out.includes('explore a l\'outil bash autorisé')) // le message ancre lui-même est visible
})

test('--at : epoch ms, forme UTC et date seule donnent la vue attendue', () => {
  const ms = sessionSlice(root, 'ses_at1', { at: String(A0 + 120000) })
  assert.equal(ms.maxIdx, 2)
  assert.equal(ms.anchor.id, null)
  assert.equal(ms.anchor.source, 'horodatage')
  // la forme horodatée est en UTC (change update-read-at) : 09:02Z = instant de la mutation
  assert.equal(sessionSlice(root, 'ses_at1', { at: '2026-09-10T09:02' }).maxIdx, 2)
  // une date seule garde la journée entière visible (convention : fin de journée UTC)
  assert.equal(sessionSlice(root, 'ses_at1', { at: '2026-09-10' }).maskedCount, 0)
})

test('--at : fenêtrer DANS la vue (--around, --ctx, --tail)', () => {
  const around = sessionSlice(root, 'ses_at1', { at: 'msg_at1mut', aroundId: 'msg_at1a', ctx: 1 })
  assert.equal(around.aroundIdx, 1)
  assert.deepEqual(around.spans, [[0, 2]]) // borné par la vue, pas par la session
  const tail = sessionSlice(root, 'ses_at1', { at: 'msg_at1mut', tail: 1 })
  assert.deepEqual(tail.spans, [[2, 2]])
})

test('--at : fenêtre entièrement postérieure → message explicite, jamais un vide ambigu', () => {
  const slice = sessionSlice(root, 'ses_at1', { at: 'msg_at1mut', aroundId: 'msg_at1c' })
  assert.deepEqual(slice.spans, [])
  assert.match(slice.error, /entièrement postérieure à l'ancre/)
  assert.match(slice.error, /msg_at1mut/)
  assert.equal(slice.fatal, undefined)
  const out = renderRead(slice, 'ses_at1', { plain: true })
  assert.ok(out.includes('msg_at1c est masqué'))
})

test('--at : ancre invalide → erreur fatale explicite (sortie non nulle côté CLI)', () => {
  const unknown = sessionSlice(root, 'ses_at1', { at: 'msg_nope' })
  assert.equal(unknown.fatal, true)
  assert.match(unknown.error, /ancre introuvable : msg_nope/)
  const other = sessionSlice(root, 'ses_at1', { at: 'msg_u1' }) // appartient à ses_fix1
  assert.equal(other.fatal, true)
  assert.match(other.error, /appartient à la session ses_fix1/)
  const junk = sessionSlice(root, 'ses_at1', { at: 'pas-une-date' })
  assert.equal(junk.fatal, true)
  assert.match(junk.error, /ancre introuvable/)
})

test('--at : JSON expose l\'ancre résolue et le compte masqué, textes intégraux', async () => {
  const { renderReadJson } = await import('../src/format.js')
  const slice = sessionSlice(root, 'ses_at1', { at: 'msg_at1mut' })
  const j = JSON.parse(renderReadJson(slice, 'ses_at1'))
  assert.equal(j.anchor.id, 'msg_at1mut')
  assert.equal(j.anchor.source, 'message')
  assert.equal(j.maskedCount, 2)
  assert.equal(j.visible, 3)
  assert.equal(j.total, 5)
  assert.equal(j.messages.length, 3)
  assert.equal(j.messages[2].text, 'Retire le bash d\'explore, il ne doit plus exécuter de commandes')
  assert.equal(j.messages[0].text, 'quels outils a l\'agent explore ?')
})

test('--at : la preuve reste entière (raw non filtré par le masquage)', () => {
  // le masquage est un filtre de lecture : les messages masqués restent dans l'archive
  const { events } = loadCorpus(root)
  const all = events.filter(e => e.sessionId === 'ses_at1')
  assert.equal(all.length, 5) // la session complète est toujours là
  const slice = sessionSlice(root, 'ses_at1', { at: 'msg_at1mut' })
  assert.equal(slice.total, 5) // la vue est bornée, la source n'est pas coupée
})

test('CLI : read --at (JSON, sortie non nulle sur ancre invalide, --at réservé à read)', () => {  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'sdig.js')
  const env = { ...process.env, SESSION_DIG_HOME: root }
  const run = args => {
    try { return { code: 0, out: execFileSync('node', [bin, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) } }
  }
  const json = run(['read', 'ses_at1', '--at', 'msg_at1mut', '--json'])
  assert.equal(json.code, 0)
  const parsed = JSON.parse(json.out)
  assert.equal(parsed.anchor.id, 'msg_at1mut')
  assert.equal(parsed.maskedCount, 2)
  const bad = run(['read', 'ses_at1', '--at', 'msg_nope'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /ancre introuvable/)
  const misplaced = run(['--at', 'msg_at1mut', 'bash'])
  assert.equal(misplaced.code, 1)
  assert.match(misplaced.err, /--at : option de `sdig read` uniquement/)
  const unknownOpt = run(['read', 'ses_at1', '--bogus', 'x'])
  assert.equal(unknownOpt.code, 1)
  assert.match(unknownOpt.err, /option inconnue : --bogus/)
})

// ── update-read-at : ancres strictes (UTC, validité calendaire, ancre vide) ──

test('--at : validité calendaire stricte, aucun report silencieux', () => {
  const cases = [
    ['2026-02-30', /jour hors bornes/], // sinon reporté au 2 mars
    ['2026-13-01', /mois hors bornes/],
    ['2026-09-00', /jour hors bornes/],
    ['2026-04-31', /jour hors bornes/],
    ['2026-09-05T25:00', /heure hors bornes/], // sinon reporté au lendemain 01:00
    ['2026-09-05T10:75', /minute hors bornes/],
    ['2026-09-05T10:30:61', /seconde hors bornes/]
  ]
  for (const [anc, re] of cases) {
    const s = sessionSlice(root, 'ses_at1', { at: anc })
    assert.equal(s.fatal, true, `ancre ${anc} : doit être fatale`)
    assert.match(s.error, /ancre invalide : /, anc)
    assert.match(s.error, re, anc)
    assert.deepEqual(s.spans, [], anc)
  }
  // années bissextiles : 2026-02-29 n'existe pas, 2028-02-29 oui
  assert.match(sessionSlice(root, 'ses_at1', { at: '2026-02-29' }).error, /jour hors bornes/)
  assert.equal(sessionSlice(root, 'ses_at1', { at: '2028-02-29' }).fatal, undefined)
})

test('--at : ancre vide refusée (jamais la session entière par accident)', () => {
  for (const anc of ['', '   ']) {
    const s = sessionSlice(root, 'ses_at1', { at: anc })
    assert.equal(s.fatal, true, JSON.stringify(anc))
    assert.match(s.error, /ancre vide/)
    assert.deepEqual(s.spans, [])
  }
  assert.match(resolveAnchor([{ id: 'm', ts: 1 }], '').error, /ancre vide/)
  // option absente (undefined) : la session entière reste légitime, sans ancre
  const absent = sessionSlice(root, 'ses_at1', {})
  assert.equal(absent.anchor, null)
  assert.equal(absent.maskedCount, 0)
})

test('--at : horodatages résolus en UTC (même référentiel que l\'affichage)', () => {
  const evs = [{ id: 'm1', ts: 0 }]
  assert.equal(resolveAnchor(evs, '2026-09-05T09:00').ts, Date.UTC(2026, 8, 5, 9, 0, 0))
  assert.equal(resolveAnchor(evs, '2026-09-05 09:00:30').ts, Date.UTC(2026, 8, 5, 9, 0, 30))
  assert.equal(resolveAnchor(evs, '2026-09-05').ts, Date.UTC(2026, 8, 5, 23, 59, 59, 999))
  assert.equal(resolveAnchor(evs, '1788607469932').ts, 1788607469932)
})

test('CLI : mêmes ancre et vue sous TZ=UTC, Europe/Paris, America/New_York', () => {
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'sdig.js')
  const run = (tz, args) => {
    try { return { code: 0, out: execFileSync('node', [bin, ...args], { encoding: 'utf8', env: { ...process.env, TZ: tz, SESSION_DIG_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) } }
  }
  const args = ['read', 'ses_at1', '--at', '2026-09-10T09:01', '--json']
  const views = ['UTC', 'Europe/Paris', 'America/New_York'].map(tz => JSON.parse(run(tz, args).out))
  for (const v of views) {
    assert.equal(v.anchor.ts, Date.UTC(2026, 8, 10, 9, 1, 0)) // 09:01 UTC, pas 09:01 local
    assert.equal(v.anchor.date, '2026-09-10 09:01')
    assert.equal(v.visible, 2) // q1 (09:00) et a1 (09:01) — la mutation de 09:02 est masquée
    assert.equal(v.maskedCount, 3)
  }
  // ancre vide (variable shell vide) : erreur, sortie non nulle — jamais la session entière
  const empty = run('UTC', ['read', 'ses_at1', '--at', '', '--json'])
  assert.equal(empty.code, 2)
  assert.match(empty.err, /ancre vide/)
  // date impossible : erreur explicite
  const impossible = run('Europe/Paris', ['read', 'ses_at1', '--at', '2026-02-30'])
  assert.equal(impossible.code, 2)
  assert.match(impossible.err, /ancre invalide : 2026-02-30 \(jour hors bornes/)
})
