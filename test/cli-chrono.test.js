// Tri CHRONOLOGIQUE de la recherche CLI (change add-cli-chronological-sort).
// Fixtures 100 % synthétiques ; `--sort` n'existe que sur la commande de recherche.
//
// Couverture tasks 2.10 : plus ancien hors top-k BM25, ts égaux multi-source
// (ordre BINARY), filtre avant tri/limite, ts = 0, source inconnue/archivée absente,
// rôle title/inconnu sans q, requête fournie vide/espaces/stopwords, `--sort` sans
// valeur, modèle absent honnête (model: null + avertissement conditionnel stderr),
// titre exclu/inclus selon q, entrelacement humain vs JSON, --ctx non candidat,
// --limit non exhaustif, refus (sous-commandes, mcp fixe, --raw), vue absente/périmée,
// non-régression relevance.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { buildFixtureDb } from './helpers/fixture.js'
import { T0, fakeUuid, sessionLine, messageLine, infoLine, writePiSession } from './helpers/pi-fixture.js'
import { ingest } from '../src/corpus.js'
import { index, search, searchChrono, browseChrono } from '../src/retriever/bm25.js'
import { renderChrono } from '../src/format.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-cli-chrono-'))
const prevPiDir = process.env.SESSION_DIG_PI_DIR

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')
const piDir = path.join(tmp, 'pi')
const indexPath = path.join(root, 'index.db')
const CLI = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
const PI_SES = fakeUuid()

function addMsg (db, { sesId, msgId, ts, role = 'user', text = null, model = null, title = sesId, directory = `/root/${sesId}`, tool = null }) {
  db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run(sesId, 'p', directory, title, ts, ts)
  const data = { role }
  if (model) data.model = model
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(msgId, sesId, ts, ts, JSON.stringify(data))
  if (text != null) db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_${msgId}`, msgId, sesId, ts, ts, JSON.stringify({ type: 'text', text }))
  if (tool) db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(`prt_tool_${msgId}`, msgId, sesId, ts + 1, ts + 1, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: tool }, metadata: { exitCode: 0 } } }))
}

before(async () => {
  buildFixtureDb(dbPath)
  const db = new Database(dbPath)
  try {
    // Base VIDÉE après création du schéma : aucune donnée dorée ne biaise l'ordre.
    db.exec('DELETE FROM part; DELETE FROM message; DELETE FROM session;')

    // Session chrono : `m_zero` à ts=0 (plus ancien), `m_old`, 20 messages très
    // pertinents pour BM25 (plus récents), modèle présent/absent, texte vide + commande.
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_zero', ts: 0, role: 'assistant', model: { providerID: 'p', modelID: 'zero' }, text: 'zebre alpha' })
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_old', ts: 1000, role: 'user', text: 'zebre' })
    for (let i = 0; i < 20; i++) addMsg(db, { sesId: 'ses_chrono', msgId: `m_new${String(i).padStart(2, '0')}`, ts: 2000 + i, role: 'user', text: Array(20).fill('zebre').join(' ') })
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_nomodel', ts: 5000, role: 'assistant', text: 'sans modele ici' })
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_model', ts: 6000, role: 'assistant', model: { providerID: 'prov', modelID: 'M' }, text: 'avec modele M' })
    addMsg(db, { sesId: 'ses_chrono', msgId: 'm_empty', ts: 7000, role: 'user', text: null, tool: 'commande vide' })

    // Deux sessions entrelacées (mots-clés `interleave`) + voisins de contexte.
    addMsg(db, { sesId: 'ses_inter_x', msgId: 'm_x0', ts: 2400, role: 'user', text: 'contexte X0' })
    addMsg(db, { sesId: 'ses_inter_x', msgId: 'm_x1', ts: 2500, role: 'user', text: 'interleave-X1' })
    addMsg(db, { sesId: 'ses_inter_x', msgId: 'm_x2', ts: 4000, role: 'user', text: 'interleave-X2' })
    addMsg(db, { sesId: 'ses_inter_x', msgId: 'm_x3', ts: 4100, role: 'user', text: 'contexte X3' })
    addMsg(db, { sesId: 'ses_inter_y', msgId: 'm_y0', ts: 2900, role: 'user', text: 'contexte Y0' })
    addMsg(db, { sesId: 'ses_inter_y', msgId: 'm_y1', ts: 3000, role: 'user', text: 'interleave-Y1' })
    addMsg(db, { sesId: 'ses_inter_y', msgId: 'm_y2', ts: 3500, role: 'user', text: 'interleave-Y2' })
    addMsg(db, { sesId: 'ses_inter_y', msgId: 'm_y3', ts: 3600, role: 'user', text: 'contexte Y3' })

    // Titre contenant un mot-clé (éligible AVEC q, exclu SANS q), ts du titre = tsCreated.
    db.prepare('INSERT OR IGNORE INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)').run('ses_titles', 'p', '/root/ses_titles', 'titre zebre', 800, 800)
    addMsg(db, { sesId: 'ses_titles', msgId: 'm_title', ts: 8000, role: 'user', text: 'autre chose', title: 'titre zebre' })

    // Source `omega` : événement opencode et événement pi au MÊME ts (départage BINARY).
    addMsg(db, { sesId: 'ses_omega', msgId: 'm_omega', ts: T0 + 300000, role: 'user', text: 'omega partage', title: 'Partage OC' })
  } finally { db.close() }

  writePiSession(piDir, 'proj', 'ses_pi.jsonl', [
    sessionLine(PI_SES, T0 + 300000, '/root/pirepo'),
    infoLine(T0 + 10, 'Partage Pi', 'inf'),
    messageLine(T0 + 300000, { role: 'user', timestamp: T0 + 300000, content: [{ type: 'text', text: 'omega partage' }] }, 'aa')
  ])

  process.env.SESSION_DIG_PI_DIR = piDir
  await ingest({ root, db: dbPath, piDir, source: 'all' })
  index(root)
})

after(() => {
  if (prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = prevPiDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

const piEventId = () => `pi:${PI_SES}:aa`

function runCli (args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--home', root], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 16 << 20,
    env: { ...process.env, SESSION_DIG_PI_DIR: piDir, ...extraEnv }
  })
  assert.ifError(r.error)
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function okJson (args) {
  const r = runCli(args)
  assert.equal(r.code, 0, `exit ${r.code} : ${r.err}`)
  const parsed = JSON.parse(r.out)
  assert.ok(Array.isArray(parsed), 'stdout = tableau JSON')
  return { parsed, raw: r }
}

// ── Retriever : ordre global, BINARY, filtres (tests directs) ───────────────

test('browseChrono : ordre (ts, id) global, user/assistant seulement, ts=0 inclus', () => {
  const hits = browseChrono(indexPath, { sort: 'oldest', limit: 500 })
  assert.equal(hits[0].id, 'm_zero')
  assert.equal(hits[0].ts, 0)
  assert.ok(hits.every((h) => h.role === 'user' || h.role === 'assistant'))
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1]; const b = hits[i]
    assert.ok(a.ts < b.ts || (a.ts === b.ts && Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)) <= 0), `ordre ${a.id} → ${b.id}`)
  }
  const newest = browseChrono(indexPath, { sort: 'newest', limit: 500 })
  assert.deepEqual(newest.map(h => h.id), hits.map(h => h.id).reverse(), 'newest inverse les deux clés, y compris les égalités')
})

test('searchChrono : score BM25 numérique diagnostique, ordre chrono, sélection globale', () => {
  const hits = searchChrono(indexPath, { q: 'zebre', sort: 'oldest', limit: 5, plain: true })
  assert.equal(hits[0].id, 'm_zero', 'le plus ancien match sort en tête hors top-k BM25')
  assert.ok(hits.every((h) => typeof h.score === 'number'))
  const rel = search(indexPath, { q: 'zebre', limit: 5, plain: true })
  assert.ok(!rel.some((h) => h.id === 'm_zero'), 'relevance top-5 exclut le plus ancien (peu pertinent)')
  assert.ok(rel.every((h) => typeof h.score === 'number'))
})

test('searchChrono : ts égaux multi-source départagés par id BINARY', () => {
  const asc = searchChrono(indexPath, { q: 'omega', sort: 'oldest', limit: 10, plain: true })
  assert.deepEqual(asc.map((h) => h.id), ['m_omega', piEventId()])
  const desc = searchChrono(indexPath, { q: 'omega', sort: 'newest', limit: 10, plain: true })
  assert.deepEqual(desc.map((h) => h.id), [piEventId(), 'm_omega'])
})

test('browseChrono : rôle title ou inconnu ⇒ zéro hit ; source inconnue ⇒ zéro hit', () => {
  assert.deepEqual(browseChrono(indexPath, { sort: 'oldest', role: 'title', limit: 50 }), [])
  assert.deepEqual(browseChrono(indexPath, { sort: 'oldest', role: 'inconnu', limit: 50 }), [])
  assert.deepEqual(browseChrono(indexPath, { sort: 'oldest', source: 'inconnue', limit: 50 }), [])
})

// ── CLI : plus ancien hors top-k, limite, filtre avant tri, ts=0 ────────────

test('CLI chrono : plus ancien hors top-k BM25 en tête de oldest --limit N', () => {
  const { parsed } = okJson(['zebre', '--sort', 'oldest', '--limit', '5', '--json'])
  assert.equal(parsed[0].id, 'm_zero')
  assert.equal(parsed[0].ts, 0)
})

test('CLI : --limit tronque (non exhaustif) et filtre AVANT tri', () => {
  const { parsed } = okJson(['zebre', '--sort', 'oldest', '--limit', '2', '--json'])
  assert.equal(parsed.length, 2)
  // filtre --role user appliqué avant tri/limite : le plus ancien est un user.
  const u = okJson(['--role', 'user', '--sort', 'oldest', '--limit', '1', '--json']).parsed
  assert.equal(u.length, 1)
  assert.equal(u[0].id, 'm_old')
  assert.equal(u[0].role, 'user')
})

test('CLI : oldest --limit 1 sans q = plus ancien MESSAGE (jamais une session)', () => {
  const { parsed } = okJson(['--sort', 'oldest', '--limit', '1', '--json'])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'm_zero')
  assert.equal(parsed[0].ts, 0)
  assert.notEqual(parsed[0].role, 'title')
})

// ── CLI : sans mots-clés (modèle, titre, texte vide, avertissement) ─────────

test('CLI sans q : model null explicite + avertissement stderr conditionnel', () => {
  const { parsed, raw } = okJson(['--role', 'assistant', '--sort', 'oldest', '--json'])
  const nm = parsed.find((h) => h.id === 'm_nomodel')
  assert.ok(nm, 'assistant sans modèle rendu')
  assert.ok(Object.hasOwn(nm, 'model'))
  assert.equal(nm.model, null, 'model: null, jamais inventé')
  assert.match(raw.err, /modèle absent/, 'avertissement conditionnel sur stderr')
  assert.ok(!raw.out.includes('modèle absent'), 'stdout reste un tableau JSON pur')
})

test('CLI sans q : --role user n’émet AUCUN avertissement de modèle', () => {
  const { parsed, raw } = okJson(['--role', 'user', '--sort', 'oldest', '--json'])
  assert.ok(parsed.length >= 1)
  assert.ok(!raw.err.includes('modèle absent'))
})

test('CLI sans q : titre exclu, événement à texte vide/commande seule inclus', () => {
  const { parsed } = okJson(['--sort', 'oldest', '--limit', '500', '--json'])
  assert.ok(parsed.every((h) => h.role !== 'title'), 'aucune ligne title sans q')
  const empty = parsed.find((h) => h.id === 'm_empty')
  assert.ok(empty, 'événement à texte vide inclus')
  assert.equal(empty.text, '')
})

test('CLI avec q : un titre reste éligible et le score est numérique', () => {
  const { parsed } = okJson(['zebre', '--sort', 'oldest', '--limit', '5', '--json'])
  assert.ok(parsed.some((h) => h.role === 'title'), 'titre éligible avec q')
  assert.ok(parsed.every((h) => typeof h.score === 'number'))
})

// ── CLI : distinctions physiques et refus ───────────────────────────────────

test('CLI : requête fournie vide/espaces/stopwords suit la normalisation (pas d’exploration)', () => {
  for (const q of ['', '   ', 'le la de']) {
    const r = runCli([q, '--sort', 'oldest', '--json'])
    assert.notEqual(r.code, 0, `doit refuser q=${JSON.stringify(q)}`)
    assert.match(r.err, /sans termes|exploitables|vide/, JSON.stringify(q))
  }
})

test('CLI : --sort sans valeur ou inconnu échoue sans consommer l’option suivante', () => {
  const missing = runCli(['interleave', '--sort', '--limit', '1', '--json'])
  assert.notEqual(missing.code, 0)
  assert.match(missing.err, /--sort/)
  assert.match(missing.err, /valeur manquante/)
  const unknown = runCli(['interleave', '--sort', 'bogus', '--json'])
  assert.notEqual(unknown.code, 0)
  assert.match(unknown.err, /--sort/)
})

test('CLI : --sort relevance sans requête échoue ; aucun argument conserve l’aide', () => {
  const rel = runCli(['--sort', 'relevance', '--json'])
  assert.notEqual(rel.code, 0)
  assert.match(rel.err, /requête manquante/)
  const help = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { ...process.env, SESSION_DIG_PI_DIR: piDir } })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
})

test('CLI : --sort refusé sur les sous-commandes (valeur valide comprise)', () => {
  for (const cmd of ['read', 'ingest', 'raw', 'index', 'refresh', 'status', 'migrate', 'fingerprint']) {
    const args = [cmd, '--sort', 'oldest']
    const r = runCli(args)
    assert.notEqual(r.code, 0, JSON.stringify(args))
    assert.match(r.err, /--sort/, JSON.stringify(args))
  }
})

test('CLI : --sort sur mcp = message FIXE sans recopie de l’argument ni de sa valeur', () => {
  const r = runCli(['mcp', '--sort', 'oldest'])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /mcp : option non reconnue/)
  assert.ok(!r.err.includes('oldest'), 'valeur non recopiée')
  assert.ok(!r.err.includes('--sort'), 'argument non recopié')
})

test('CLI : --raw + chrono refusé, mode --raw par défaut inchangé', () => {
  const r = runCli(['omega', '--sort', 'oldest', '--raw'])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /--raw/)
  // relevance + --raw reste accepté (aucun résultat brut ici ne doit faire échouer).
  const ok = runCli(['omega', '--raw'])
  assert.equal(ok.code, 0)
})

// ── CLI : affichage, --ctx, JSON ────────────────────────────────────────────

test('CLI : entrelacement global humain préservé ; JSON reste un tableau', () => {
  const human = runCli(['interleave', '--sort', 'oldest', '--plain'])
  assert.equal(human.code, 0)
  assert.match(human.out, /tri chronologique : oldest/)
  const clean = human.out.replaceAll('»', '').replaceAll('«', '')
  const ix = (s) => clean.indexOf(s)
  assert.ok(ix('interleave-X1') < ix('interleave-Y1'))
  assert.ok(ix('interleave-Y1') < ix('interleave-Y2'))
  assert.ok(ix('interleave-Y2') < ix('interleave-X2'))
  const { parsed } = okJson(['interleave', '--sort', 'oldest', '--json'])
  assert.deepEqual(parsed.map((h) => h.id), ['m_x1', 'm_y1', 'm_y2', 'm_x2'])
})

test('CLI : --ctx rend des VOISINS distincts, jamais candidats, sans clé JSON', () => {
  const human = runCli(['interleave', '--sort', 'oldest', '--ctx', '1', '--plain'])
  assert.equal(human.code, 0)
  assert.match(human.out, /4 hit\(s\)/)
  assert.equal((human.out.match(/►/g) || []).length, 4, 'exactement 4 hits marqués')
  assert.ok(human.out.includes('contexte X0'), 'voisin de contexte affiché')
  assert.ok(!/►[^\n]*contexte X0/.test(human.out), 'le voisin n’est pas un candidat')
  const clean = human.out.replaceAll('»', '').replaceAll('«', '')
  for (const text of ['interleave-X1', 'interleave-Y1', 'interleave-Y2', 'interleave-X2']) {
    assert.equal(clean.split(text).length - 1, 1, `${text} ne doit pas réapparaître comme voisin`)
  }
  const { parsed } = okJson(['interleave', '--sort', 'oldest', '--ctx', '1', '--json'])
  assert.equal(parsed.length, 4)
  for (const h of parsed) {
    assert.ok(!('contexte' in h) && !('ctx' in h), 'aucune clé de contexte en JSON')
  }
})

test('rendu chrono sans q : texte et commandes bornés sans coupure silencieuse, --full intégral', () => {
  const hits = [{ id: 'display', session_id: 'ses_display', ts: 0, role: 'user', score: null, text: 'texte '.repeat(100), cmd: 'commande '.repeat(100) }]
  const out = renderChrono(hits, new Map(), { plain: true })
  assert.equal((out.match(/message tronqué à l'affichage/g) || []).length, 1)
  assert.equal((out.match(/commande tronquée à l'affichage/g) || []).length, 1)
  assert.match(out, /sdig read ses_display --around display --json/)
  assert.match(out, /\$ commande/)
  const full = renderChrono(hits, new Map(), { plain: true, full: true })
  assert.ok(full.includes(hits[0].text))
  assert.ok(full.includes(hits[0].cmd))
  assert.ok(!full.includes('message tronqué'))
  assert.ok(!full.includes('commande tronquée'))
})

test('CLI chrono : commande seule visible et scores FTS explicitement diagnostiques', () => {
  const command = runCli(['--sort', 'oldest', '--session', 'ses_chrono', '--after', '1970-01-01T00:00:07Z', '--plain'])
  assert.equal(command.code, 0)
  assert.match(command.out, /\$ commande vide/)
  const scored = runCli(['zebre', '--sort', 'oldest', '--limit', '1', '--plain'])
  assert.equal(scored.code, 0)
  assert.match(scored.out, /BM25 .*\(diagnostic\)/)
})

test('rendu chrono : un titre ne récupère pas les fenêtres distantes de ses autres hits', () => {
  const hits = [
    { id: 'ses_title_ctx', session_id: 'ses_title_ctx', ts: 5, role: 'titre', text: 'titre candidat', score: -1 },
    { id: 'farhit', session_id: 'ses_title_ctx', ts: 100, role: 'user', text: 'hit distant', score: -2 }
  ]
  const evs = [
    { id: 'near', ts: 6, text: 'voisin du titre' },
    { id: 'farbefore', ts: 99, text: 'voisin avant distant' },
    { id: 'farhit', ts: 100, text: 'hit distant' },
    { id: 'farafter', ts: 101, text: 'voisin après distant' }
  ].map(e => ({ ...e, sessionId: 'ses_title_ctx', role: 'user' }))
  const ctxBySession = new Map([['ses_title_ctx', { total: 100, evs, absIdx: [0, 97, 98, 99] }]])
  const out = renderChrono(hits, new Map(), { plain: true, ctx: 1, ctxBySession })
  assert.ok(out.indexOf('titre candidat') < out.indexOf('voisin du titre'), 'successeur après le titre')
  assert.ok(out.indexOf('voisin avant distant') > out.indexOf('titre candidat'), 'pas toutes les fenêtres avant le titre')
  assert.equal(out.split('hit distant').length - 1, 1, 'hit non dupliqué en voisin')
  assert.ok(out.indexOf('voisin avant distant') < out.indexOf('hit distant'))
  assert.ok(out.indexOf('hit distant') < out.indexOf('voisin après distant'))
})

test('CLI chrono : limite entière positive stricte, avec et sans requête', () => {
  for (const q of [[], ['zebre']]) {
    for (const limit of ['0', '-1', '1.5', '2oops', '', 'Infinity', '9007199254740992']) {
      const r = runCli([...q, '--sort', 'oldest', '--limit', limit, '--json'])
      assert.notEqual(r.code, 0, `limite ${JSON.stringify(limit)}`)
      assert.match(r.err, /--limit/)
    }
  }
})

test('CLI chrono : filtres repo/session littéral et avertissement limité aux hits rendus', () => {
  for (const q of [[], ['interleave']]) {
    const hits = okJson([...q, '--sort', 'newest', '--repo', 'ses_inter_x', '--session', 'ses_inter_x', '--limit', '1', '--json']).parsed
    assert.equal(hits.length, 1)
    assert.equal(hits[0].sessionId, 'ses_inter_x')
  }
  const { parsed, raw } = okJson(['--role', 'assistant', '--sort', 'oldest', '--limit', '1', '--json'])
  assert.equal(parsed[0].id, 'm_zero')
  assert.ok(!raw.err.includes('modèle absent'), 'un assistant absent du rendu ne déclenche pas l’alerte')
})

// ── CLI : source archivée absente, source inconnue ──────────────────────────

test('CLI : source pi archivée absente du disque reste cherchable (provenance archivée)', () => {
  const backup = path.join(tmp, 'pi-backup')
  fs.cpSync(piDir, backup, { recursive: true })
  fs.rmSync(piDir, { recursive: true, force: true })
  try {
    const { parsed } = okJson(['omega', '--sort', 'oldest', '--source', 'pi', '--json'])
    assert.deepEqual(parsed.map((h) => h.id), [piEventId()])
    const unknown = okJson(['omega', '--sort', 'oldest', '--source', 'inconnue', '--json'])
    assert.deepEqual(unknown.parsed, [])
  } finally {
    fs.cpSync(backup, piDir, { recursive: true })
    fs.rmSync(backup, { recursive: true, force: true })
  }
})

// ── CLI : bornes temporelles UTC et filtre --model (chrono) ──────────────

test('CLI chrono : --after/--before (UTC) filtrent AVANT tri', () => {
  const after = okJson(['omega', '--sort', 'oldest', '--after', '2027', '--json']).parsed
  assert.deepEqual(after.map((h) => h.id), ['m_omega', piEventId()])
  assert.deepEqual(okJson(['omega', '--sort', 'oldest', '--before', '2026', '--json']).parsed, [])
})

test('CLI chrono : --model sous-chaîne (avec et sans q)', () => {
  const withQ = okJson(['zebre', '--sort', 'oldest', '--model', 'zero', '--json']).parsed
  assert.ok(withQ.length >= 1)
  assert.ok(withQ.every((h) => (h.model || '').includes('zero')))
  const noQ = okJson(['--role', 'assistant', '--model', 'prov', '--sort', 'oldest', '--json']).parsed
  assert.deepEqual(noQ.map((h) => h.id), ['m_model'])
})

// ── CLI : non-régression relevance ──────────────────────────────────────────

test('CLI relevance (défaut) : scores numériques, plus ancien non remonté artificiellement', () => {
  const { parsed } = okJson(['zebre', '--limit', '5', '--json'])
  assert.ok(parsed.length >= 1)
  assert.ok(parsed.every((h) => typeof h.score === 'number'))
  assert.ok(!parsed.some((h) => h.id === 'm_zero'), 'relevance inchangé (pas de tri chrono implicite)')
})

// ── CLI : vue absente / périmée (en DERNIER : la copie est corrompue) ───────

test('CLI : vue absente (index absent) et vue périmée (state en avance) refusées', () => {
  const emptyRoot = path.join(tmp, 'vide')
  fs.mkdirSync(emptyRoot, { recursive: true })
  const absent = spawnSync(process.execPath, [CLI, 'omega', '--sort', 'oldest', '--home', emptyRoot], { encoding: 'utf8', env: { ...process.env, SESSION_DIG_PI_DIR: piDir } })
  assert.notEqual(absent.status, 0)
  assert.match(absent.stderr, /index absent/)

  // Copie jetable : state.json en AVANCE sur la vue ⇒ vue périmée.
  const copy = path.join(tmp, 'copie')
  fs.cpSync(root, copy, { recursive: true })
  const stPath = path.join(copy, 'state.json')
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  st.sources.opencode.message = (st.sources.opencode.message ?? 0) + 1
  fs.writeFileSync(stPath, JSON.stringify(st))
  const stale = spawnSync(process.execPath, [CLI, 'omega', '--sort', 'oldest', '--home', copy], { encoding: 'utf8', env: { ...process.env, SESSION_DIG_PI_DIR: piDir } })
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /retard|refresh|périm/)
  assert.ok(!stale.stdout.includes('omega'), 'aucune donnée rendue sur vue périmée')
})
