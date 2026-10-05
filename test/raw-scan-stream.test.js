// scale-corpus, sous-partie rawScan : parcours EN FLUX des références de preuves.
// Prouve, sans million de fichiers ni benchmark long, que rawScan (1) consomme
// `rawrefs` par itérateur paresseux (jamais `.all()`, aucun LIMIT arbitraire),
// (2) borne la sortie à `limit` en s'arrêtant tôt, (3) referme itérateur,
// connexion et fd de preuve sur TOUS les chemins (épuisement, break, erreur DB,
// erreur de lecture), sans avaler l'erreur de lecture (aujourd'hui propagée).
// Fixtures 100 % synthétiques sous tmp, vue dérivable minimale + preuves réelles.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SCHEMA } from '../src/view.js'
import { rawShardPath } from '../src/layout.js'
import { rawScan } from '../src/raw.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-raw-stream-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

let seq = 0

/** Vue dérivable minimale VALIDE (schéma v2 + watermark frais vs state.json) :
 *  openView l'accepte, donc rawScan l'utilise comme la vraie vue. */
function makeRoot ({ refs = [], staleState = null } = {}) {
  const root = path.join(tmp, `corpus-${seq++}`)
  fs.mkdirSync(root, { recursive: true })
  const db = new Database(path.join(root, 'index.db'))
  db.exec(SCHEMA)
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('layoutVersion', '2')
  db.prepare('INSERT INTO watermark(source,token,message,session) VALUES(?,?,?,?)').run('opencode', 't', 0, 0)
  const ins = db.prepare('INSERT INTO rawrefs(rawRef,eventId,sessionId,ts,role,tool,cmd) VALUES(?,?,?,?,?,?,?)')
  const tx = db.transaction(() => {
    for (const r of refs) {
      ins.run(r.rawRef, r.eventId ?? `e_${r.rawRef}`, r.sessionId ?? 'ses_1', r.ts ?? 1, r.role ?? 'assistant', r.tool ?? 'bash', r.cmd ?? null)
    }
  })
  tx()
  db.close()
  fs.writeFileSync(path.join(root, 'state.json'),
    JSON.stringify(staleState ?? { sources: { opencode: { message: 0, session: 0 } } }))
  return root
}

/** Écrit une preuve réelle au chemin shardé attendu et retourne son chemin. */
function writeProof (root, partId, content) {
  const f = rawShardPath(path.join(root, 'raw'), partId)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
  return f
}

/**
 * Instrumente le prototype des Statement better-sqlite3 : compte `.all()` vs
 * `.iterate()`, capture le SQL source de l'itérateur, et compte les appels
 * `next()`/`return()` de chaque itérateur rendu. `hooks.next`/`hooks.return`
 * permettent d'injecter un comportement (erreur DB) tout en gardant le nettoyage.
 */
function instrumentStatements (hooks = {}) {
  const probe = new Database(':memory:')
  const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'))
  probe.close()
  const orig = { all: proto.all, iterate: proto.iterate }
  const calls = { all: 0, iterate: 0, allSql: [], iterateSql: [], next: 0, ret: 0, databases: [] }
  // NB : openView/checkFresh interrogent la vue par `.all()` — on distingue donc
  // la REQUÊTE visée (rawrefs) des requêtes internes de la vue.
  proto.all = function (...a) { calls.all++; calls.allSql.push(this.source); return orig.all.apply(this, a) }
  proto.iterate = function (...a) {
    calls.iterate++
    calls.iterateSql.push(this.source)
    calls.databases.push(this.database)
    const it = orig.iterate.apply(this, a)
    return {
      [Symbol.iterator] () { return this },
      next () { calls.next++; return hooks.next ? hooks.next(it, calls) : it.next() },
      return () { calls.ret++; return hooks.return ? hooks.return(it, calls) : (it.return ? it.return() : { done: true }) }
    }
  }
  return { calls, restore () { proto.all = orig.all; proto.iterate = orig.iterate } }
}

function fdCount () {
  try { return fs.readdirSync('/proc/self/fd').length } catch { return null }
}

test('rawScan : parcours en flux, ordre d’insertion et première correspondance par preuve', () => {
  const refs = [
    { rawRef: 'prt_a' }, { rawRef: 'prt_b' }, { rawRef: 'prt_c' }, { rawRef: 'prt_d' }
  ]
  const root = makeRoot({ refs })
  for (const r of refs) writeProof(root, r.rawRef, 'needle premiere\nligne sans\nneedle seconde\n')

  const all = rawScan(root, 'needle', { limit: 10 })
  assert.deepEqual(all.map(x => x.rawRef), ['prt_a', 'prt_b', 'prt_c', 'prt_d'], 'ordre du parcours rawrefs préservé')
  for (const hit of all) {
    assert.equal(hit.line, 'needle premiere', 'première correspondance de la preuve retenue')
    assert.equal(hit.lineNo, 1, 'numéro de ligne de la première correspondance')
    assert.equal(hit.sessionId, 'ses_1')
    assert.equal(hit.tool, 'bash')
  }
  // borné par limit : les références suivantes ne sont pas retournées
  assert.deepEqual(rawScan(root, 'needle', { limit: 2 }).map(x => x.rawRef), ['prt_a', 'prt_b'], 'sortie bornée par limit')
  assert.deepEqual(rawScan(root, 'needle', { limit: 0 }), [], 'limit 0 → aucune sortie')
})

test('rawScan : .iterate() utilisé (jamais .all()), aucune clause LIMIT, itération paresseuse', () => {
  const refs = Array.from({ length: 50 }, (_, i) => ({ rawRef: `prt_${String(i).padStart(3, '0')}` }))
  const root = makeRoot({ refs })
  for (const r of refs) writeProof(root, r.rawRef, 'needle\n')

  const inst = instrumentStatements()
  try {
    const out = rawScan(root, 'needle', { limit: 1 })
    assert.equal(out.length, 1)
    assert.ok(!inst.calls.allSql.some(s => /FROM rawrefs/.test(s)), 'la requête de références n’est jamais exécutée via .all()')
    const refsSql = inst.calls.iterateSql.filter(s => /FROM rawrefs/.test(s))
    assert.equal(refsSql.length, 1, 'une itération de rawrefs par scan')
    assert.doesNotMatch(refsSql[0], /\bLIMIT\b/i, 'aucun plafond LIMIT arbitraire dans la requête de références')
    // 50 références, limit 1 : aucune sollicitation de la 2e référence.
    assert.equal(inst.calls.next, 1, 'arrêt avant la référence suivante')
    assert.ok(inst.calls.ret >= 1, 'break → return() de l’itérateur appelé')
    assert.ok(inst.calls.databases.every(db => !db.open), 'connexion du scan fermée')
  } finally { inst.restore() }
})

test('rawScan : limit atteint évite toute erreur de la référence suivante', () => {
  const root = makeRoot({ refs: [{ rawRef: 'prt_first' }, { rawRef: 'prt_second' }] })
  writeProof(root, 'prt_first', 'needle\n')
  const inst = instrumentStatements({
    next: (it, calls) => { if (calls.next === 2) throw new Error('AFTER_LIMIT'); return it.next() }
  })
  try {
    assert.equal(rawScan(root, 'needle', { limit: 1 }).length, 1)
    assert.equal(inst.calls.next, 1)
    assert.ok(inst.calls.databases.every(db => !db.open))
  } finally { inst.restore() }
})

test('rawScan : break sur limit libère itérateur et connexion (aucune connexion « busy »)', () => {
  const refs = Array.from({ length: 8 }, (_, i) => ({ rawRef: `prt_${i}` }))
  const root = makeRoot({ refs })
  for (const r of refs) writeProof(root, r.rawRef, 'needle\n')

  const inst = instrumentStatements()
  try {
    const out = rawScan(root, 'needle', { limit: 3 })
    assert.equal(out.length, 3)
    assert.ok(inst.calls.ret >= 1, 'return() appelé pour libérer l’itérateur')
    assert.ok(inst.calls.databases.every(db => !db.open), 'connexion du scan fermée')
  } finally { inst.restore() }
  // la vue reste ouvrable/fermable normalement : aucune connexion laissée active
  const db = new Database(path.join(root, 'index.db'), { readonly: true, fileMustExist: true })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rawrefs').get().n, 8)
  db.close()
})

test('rawScan : erreur DB en cours d’itération propagée, itérateur/connexion nettoyés', () => {
  const refs = Array.from({ length: 5 }, (_, i) => ({ rawRef: `prt_${i}` }))
  const root = makeRoot({ refs })
  for (const r of refs) writeProof(root, r.rawRef, 'needle\n')

  const inst = instrumentStatements({
    next: (it, calls) => { if (calls.next === 2) throw new Error('INJECTED_DB') ; return it.next() }
  })
  try {
    assert.throws(() => rawScan(root, 'needle', { limit: 10 }), (e) => {
      // l'erreur du parcours remonte telle quelle ; si l'itérateur/connexion
      // n'étaient pas nettoyés, `db.close()` lèverait « busy » et masquerait
      // l'erreur injectée.
      assert.equal(e.message, 'INJECTED_DB')
      return true
    })
    assert.ok(inst.calls.ret >= 1, 'return() appelé pour libérer l’itérateur avant close()')
    assert.ok(inst.calls.databases.every(db => !db.open), 'connexion fermée malgré erreur DB')
  } finally { inst.restore() }
})

test('rawScan : erreur de lecture d’une preuve propagée (jamais avalée), fd/connexion nettoyés', () => {
  const root = makeRoot({ refs: [{ rawRef: 'prt_io' }] })
  writeProof(root, 'prt_io', 'needle\n')

  const inst = instrumentStatements()
  const origReadSync = fs.readSync
  let failedFd = null
  fs.readSync = (fd) => { failedFd = fd; throw new Error('IO_READ') }
  try {
    assert.throws(() => rawScan(root, 'needle', { limit: 5 }), (e) => {
      assert.equal(e.message, 'IO_READ', 'erreur de lecture remontée, non avalée par un catch global')
      return true
    })
    assert.ok(inst.calls.ret >= 1, 'itérateur libéré malgré l’erreur de lecture')
    assert.ok(inst.calls.databases.every(db => !db.open), 'connexion fermée malgré erreur E/S')
  } finally {
    fs.readSync = origReadSync
    inst.restore()
  }
  assert.notEqual(failedFd, null, 'lecture de preuve effectivement exercée')
  assert.throws(() => fs.fstatSync(failedFd), e => e.code === 'EBADF', 'fd de preuve fermé')
  assert.equal(fs.readFileSync(rawShardPath(path.join(root, 'raw'), 'prt_io'), 'utf8'), 'needle\n')
})

test('rawScan : parcours épuisé ou vide ferme sa connexion', () => {
  const empty = makeRoot()
  const absentProof = makeRoot({ refs: [{ rawRef: 'prt_absent' }] })
  const inst = instrumentStatements()
  try {
    assert.deepEqual(rawScan(empty, 'needle'), [])
    assert.deepEqual(rawScan(absentProof, 'needle'), [])
    assert.equal(inst.calls.databases.length, 2)
    assert.ok(inst.calls.databases.every(db => !db.open))
  } finally { inst.restore() }
})

test('rawScan : échec de préparation SQL ferme la connexion et remonte l’erreur', () => {
  const root = makeRoot()
  const db = new Database(path.join(root, 'index.db'))
  db.exec('DROP TABLE rawrefs')
  db.close()
  const originalClose = Database.prototype.close
  const closed = []
  Database.prototype.close = function (...args) {
    closed.push(this)
    return originalClose.apply(this, args)
  }
  try {
    assert.throws(() => rawScan(root, 'needle'), /no such table: rawrefs/)
    assert.equal(closed.length, 1)
    assert.ok(!closed[0].open, 'connexion fermée sans itérateur créé')
  } finally { Database.prototype.close = originalClose }
})

test('rawScan : vue absente ou périmée → [] sans fuite de descripteurs', () => {
  const absent = path.join(tmp, 'aucun-corpus')
  const stale = makeRoot({ refs: [{ rawRef: 'prt_x' }], staleState: { sources: { opencode: { message: 5, session: 5 } } } })
  writeProof(stale, 'prt_x', 'needle\n')

  const before = fdCount()
  for (let i = 0; i < 60; i++) {
    assert.deepEqual(rawScan(absent, 'needle'), [], 'vue absente → aucune preuve, pas de crash')
    assert.deepEqual(rawScan(stale, 'needle'), [], 'vue périmée → aucune preuve, pas de crash')
  }
  const after = fdCount()
  if (before != null && after != null) {
    assert.ok(after <= before + 2, `aucune fuite de descripteurs (avant ${before}, après ${after})`)
  }
})

test('rawScan : aiguille vide et source inconnue → [] sans aucune lecture', () => {
  const root = makeRoot({ refs: [{ rawRef: 'prt_x' }] })
  writeProof(root, 'prt_x', 'needle\n')
  // toute lecture disque lèverait : les gardes doivent court-circuiter avant
  const orig = { exists: fs.existsSync, lstat: fs.lstatSync, open: fs.openSync }
  fs.existsSync = () => { throw new Error('LECTURE_INTERDITE') }
  fs.lstatSync = () => { throw new Error('LECTURE_INTERDITE') }
  fs.openSync = () => { throw new Error('LECTURE_INTERDITE') }
  try {
    assert.deepEqual(rawScan(root, '   '), [], 'aiguille vide → []')
    assert.deepEqual(rawScan(root, ''), [], 'aiguille absente → []')
    assert.deepEqual(rawScan(root, 'needle', { source: 'warp' }), [], 'source inconnue → []')
    assert.deepEqual(rawScan(root, 'needle', { source: '' }), [], 'source vide → []')
  } finally {
    fs.existsSync = orig.exists
    fs.lstatSync = orig.lstat
    fs.openSync = orig.open
  }
})

test('rawScan : filtres source exacts et orpheline pi hors scan', () => {
  const refs = [
    { rawRef: 'pi:u1:c1' },
    { rawRef: 'prt_oc1' },
    { rawRef: 'pi:u2:c9' }
  ]
  const root = makeRoot({ refs })
  for (const r of refs) writeProof(root, r.rawRef, 'needle\n')
  // preuve pi ORPHELINE (rien dans rawrefs) : jamais scannée, même si elle matche
  writeProof(root, 'pi:u3:orpheline', 'needle orpheline\n')

  assert.deepEqual(rawScan(root, 'needle', { source: 'pi' }).map(x => x.rawRef), ['pi:u1:c1', 'pi:u2:c9'], 'source pi : seules les réf pi référencées')
  assert.deepEqual(rawScan(root, 'needle', { source: 'opencode' }).map(x => x.rawRef), ['prt_oc1'], 'source opencode : aucune réf pi')
  assert.deepEqual(rawScan(root, 'needle', { source: 'all' }).map(x => x.rawRef), ['pi:u1:c1', 'prt_oc1', 'pi:u2:c9'], 'all/absent : toutes les preuves référencées')
  assert.equal(rawScan(root, 'orpheline', {}).length, 0, 'orpheline pi hors scan quelle que soit la source')
})

test('rawScan : la dernière référence est atteinte (aucun plafond de parcours)', () => {
  // le match n'existe que sur la DERNIÈRE référence : si un plafond court-circuitait
  // le parcours, il serait manqué. Combiné au test d'instrumentation (aucun LIMIT
  // dans le SQL), établit l'absence de plafond sans matérialiser un million de lignes.
  const refs = Array.from({ length: 400 }, (_, i) => ({ rawRef: `prt_${String(i).padStart(3, '0')}` }))
  const root = makeRoot({ refs })
  for (const r of refs.slice(0, -1)) writeProof(root, r.rawRef, 'rien ici\n')
  writeProof(root, refs.at(-1).rawRef, 'marqueur terminal unique\n')

  const out = rawScan(root, 'marqueur terminal unique', { limit: 5 })
  assert.equal(out.length, 1)
  assert.equal(out[0].rawRef, refs.at(-1).rawRef, 'dernière référence atteinte et retournée')
})
