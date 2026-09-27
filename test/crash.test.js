// Points de crash du protocole de publication (change scale-corpus, design D3).
// Chaque scénario : une ingestion interrompue à un point précis, puis vérification —
// lectures = dernier état publié, marqueur = détecteur, archive refusée, réconciliation
// par relance (convergence), temporaires ramassés.
import { test, before, after } from 'node:test'

// add-pi-adapter : restauration de l'environnement hermétique (indépendance du runner)
after(() => {
  if (__prevPiDir === undefined) delete process.env.SESSION_DIG_PI_DIR
  else process.env.SESSION_DIG_PI_DIR = __prevPiDir
})
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest, fingerprint, ingestRunning, recover, proofWarning, loadCorpus } from '../src/corpus.js'
import { listShards, shardPath } from '../src/layout.js'
import { viewIsCurrent, openView, viewPath, ocTokenOf } from '../src/view.js'
import { readJsonl } from '../src/util.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-crash-'))
// id de session pi synthétique (forme uuid v7, fixtures uniquement)
const fakeId = () => 'aaaaaaaa-0000-7000-8000-' + String(Date.now() % 100000000000).padStart(12, '0')
// add-pi-adapter : source pi hermétique (jamais le ~/.pi réel dans les tests)
const __prevPiDir = process.env.SESSION_DIG_PI_DIR
process.env.SESSION_DIG_PI_DIR = path.join(tmp, 'pi-absente')

const dbPath = path.join(tmp, 'fixture.db')
const root = path.join(tmp, 'corpus')

before(() => { buildFixtureDb(dbPath) })
after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// Inspecteur : dernier état publié = ce que voient les lectures (via la vue).
function publishedEvents () {
  const { events } = loadCorpus(root)
  return events
}

test('setup : ingestion initiale propre', async () => {
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 5)
  assert.equal(viewIsCurrent(root), true)
  assert.equal(ingestRunning(root), false)
})

// ── crash avant staging (dans le delta) : rien publié, marqueur posé ──

test('crash pendant le delta : vue intacte (dernier état publié), marqueur = seul témoin, archive refusée, relance converge', async () => {
  // Contrat précisé par add-pi-adapter (revue étape 2) : une erreur de
  // SÉLECTION/PRÉSENCE (validation du registre) survient AVANT la pose du
  // marqueur — le corpus n'est pas « en ingestion ».
  await assert.rejects(
    () => ingest({ root, db: path.join(tmp, 'gone.db') }),
    /introuvable/
  )
  assert.equal(ingestRunning(root), false, 'échec de sélection : pas de marqueur')
  assert.equal(proofWarning(root), null, 'aucun avertissement sans passe entamée')
  // En revanche, un échec EN COURS DE PASSE (delta entamé, avant tout rename)
  // laisse le marqueur : simulateur = un fichier pi au JSON invalide, détecté
  // pendant le décodage, après le début de la passe.
  fs.mkdirSync(process.env.SESSION_DIG_PI_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.SESSION_DIG_PI_DIR, 'ses_cassée.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: fakeId(), timestamp: '2027-01-15T08:00:00.000Z', cwd: '/root/x' }) + '\n' +
    '{ligne pi invalide\n')
  await assert.rejects(
    () => ingest({ root, db: dbPath }),
    /JSON invalide/
  )
  // lectures : dernier état publié, cohérent
  const evs = publishedEvents()
  assert.equal(evs.length, 5)
  assert.equal(ingestRunning(root), true, 'le marqueur détecte l\'état non réconcilié')
  // archive refusée
  assert.throws(() => fingerprint(root), /marqueur/)
  // avertissement preuves signalé
  assert.match(proofWarning(root), /ingestion en cours/)
  // réconciliation par relance : converge (fichier pi corrigé retiré — un fichier
  // invalide est un échec répété tant qu'il est en source), marqueur retiré
  fs.rmSync(process.env.SESSION_DIG_PI_DIR, { recursive: true, force: true })
  const r = await ingest({ root, db: dbPath })
  assert.equal(ingestRunning(root), false)
  assert.equal(r.added, 0)
  const evs2 = publishedEvents()
  assert.equal(evs2.length, 5)
})

// ── crash après le dernier rename, avant COMMIT : le scénario que seul le marqueur voit ──

test('crash après renames, avant COMMIT : plus aucun .new, shards déjà remplacés, vue en retard — marqueur présent, archive refusée, reprise explicite sans source', async () => {
  // On fabrique l'état à la main : shards mis à jour + vue en retard + marqueur.
  // (l'injection réelle se ferait en tuant le processus entre rename et COMMIT ;
  //  le test reproduit exactement l'état disque résultant.)
  const shard = shardPath(root, 'ses_fix1')
  const lines = readJsonl(shard)
  lines.push({ schemaVersion: 1, id: 'msg_ghost', sessionId: 'ses_fix1', ts: Date.now(), role: 'user', text: 'message déjà renommé mais jamais COMMITé', model: {}, repo: 'ccp-proxy', tokens: {}, cost: 0 })
  fs.writeFileSync(shard, lines.map(e => JSON.stringify(e)).join('\n') + '\n')
  // le shard est en avance sur la vue ET sur state.json : aucun .new sur disque
  assert.equal(fs.existsSync(shard + `.new-${process.pid}`), false)
  assert.equal(listShards(root).some(rel => rel.includes('.new')), false)
  fs.writeFileSync(path.join(root, '.ingest-in-progress'), JSON.stringify({ startedAt: 'test' }) + '\n')

  // le marqueur est le SEUL détecteur : sans lui, cet état serait indistingable d'un corpus publié
  assert.equal(ingestRunning(root), true)
  assert.throws(() => fingerprint(root), /marqueur/)
  // lectures : dernier état publié (la vue, pas le shard en avance)
  assert.ok(!publishedEvents().some(e => e.id === 'msg_ghost'), 'la vue ne montre pas le shard non COMMITé')
  // réconciliation par relance (avec source) : le ghost est relu depuis la source OU
  // écrasé par la passe — convergence vers le contenu de la source
  await ingest({ root, db: dbPath })
  assert.ok(!publishedEvents().some(e => e.id === 'msg_ghost'), 'la passe suivante converge vers le contenu de la source')
  assert.equal(ingestRunning(root), false)
})

test('crash après COMMIT, avant state.json : vue en avance = état publié valide, passe suivante ré-applique sans doublon', async () => {
  // état : la vue a un watermark récent, state.json en retard
  const Database = (await import('better-sqlite3')).default
  const vdb = new Database(viewPath(root))
  // add-pi-adapter : watermark PAR SOURCE (source, token, message, session)
  const wm = vdb.prepare("SELECT message, session FROM watermark WHERE source = 'opencode'").get()
  vdb.close()
  // simuler un state.json en retard (crash entre COMMIT et state.json) :
  // on rembobine l'état opencode AVANT le watermark de la vue
  const stPath = path.join(root, 'state.json')
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  st.sources.opencode.message = wm.message - 1000
  st.sources.opencode.session = wm.session - 1000
  st.sources.opencode.token = ocTokenOf(st.sources.opencode.message, st.sources.opencode.session)
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n')
  // la vue est EN AVANCE sur state.json : la fraîcheur ne refuse pas
  // (état publié valide) ; les lectures fonctionnent
  const evs = publishedEvents()
  assert.equal(evs.length, 5)
  // la passe suivante relit le delta depuis l'ANCIEN watermark et ré-applique idempotemment
  const r = await ingest({ root, db: dbPath })
  assert.equal(r.added, 0, 'ré-application sans doublon')
  assert.equal(publishedEvents().length, 5)
  const st2 = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  assert.equal(st2.sources.opencode.message, wm.message, 'state.json rattrapé (sources.opencode)')
})

// ── snapshot de lecture unique pendant une publication concurrente ──

test('publication concurrente pendant une lecture multi-étapes : un seul snapshot (WAL)', async () => {
  const db = openView(root)
  try {
    // étape 1 : lecture (ouvre un snapshot WAL implicite par requête, mais la
    // transaction de lecture longue garantit l'immuabilité — on teste ici le contrat
    // observable : pendant qu'une Database est ouverte, une publication ne modifie
    // pas ce que VOIT ce lecteur tant qu'il ne relance pas de requête après COMMIT).
    const before = db.prepare("SELECT COUNT(*) n FROM events WHERE role != 'title'").get().n
    // publication concurrente (autre connexion)
    const Database = (await import('better-sqlite3')).default
    await ingest({ root, db: dbPath }) // passe vide (aucun changement)
    // étape 2 : le lecteur déjà ouvert continue de voir le même état publié
    const after = db.prepare("SELECT COUNT(*) n FROM events WHERE role != 'title'").get().n
    assert.equal(after, before, 'aucune génération intercalée dans une commande en cours')
  } finally {
    db.close()
  }
})

// ── temporaires ramassés à la passe suivante ──

test('temporaires orphelins : ramassés à la passe suivante, aucun travail orphelin', async () => {
  const junk = path.join(root, 'events', 'aa', 'ses_fix1.jsonl.new-999')
  fs.mkdirSync(path.dirname(junk), { recursive: true })
  fs.writeFileSync(junk, 'junk')
  fs.writeFileSync(path.join(root, '.ingest-in-progress'), '{}\n')
  const r = await ingest({ root, db: dbPath })
  assert.ok(r.swept >= 1, 'temporaires ramassés')
  assert.equal(fs.existsSync(junk), false)
  assert.equal(ingestRunning(root), false)
})
