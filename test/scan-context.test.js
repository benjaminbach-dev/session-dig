// Lot 2 : scanner et présence des hits dans le contexte, fixtures isolées.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { scanText } from '../src/util.js'
import { neighborsBySessionDb } from '../src/read.js'
import { SCHEMA, inReadTx } from '../src/view.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-scan-context-'))
const file = path.join(tmp, 'proof.txt')
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
function scan(text, needle, chunkSize, stop = false) {
  fs.writeFileSync(file, text)
  const hits = []
  const count = scanText(file, needle, { chunkSize, onMatch: (line, lineNo) => {
    hits.push({ line, lineNo }); return !stop
  } })
  assert.equal(count, hits.length)
  return hits
}

for (const [name, text, needle, lines] of [
  ['petit fichier et début', 'error\n', 'error', [1]],
  ['casse et fin sans newline', 'ERROR\nError\nerror', 'eRrOr', [1, 2, 3]],
  ['frontières et lignes absolues', 'z\n'.repeat(80) + 'ÉCHEC\nx\nÉchec', 'échec', [81, 83]],
  ['recouvrement sans doublons', 'x'.repeat(90) + 'error error\nerror', 'error', [1, 1, 2]],
  ['occurrences chevauchantes', 'aaaa', 'aa', [1, 1, 1]],
  ['UTF8 et caractères supplémentaires', 'é😀É\n😀é', '😀é', [1, 2]],
  ['requête littérale', 'a.b [x] aXb\nA.B', 'a.b', [1, 2]],
  ['métacaractères', 'x [a]+(b)?\\$', '[a]+(b)?\\$', [1]],
  ['aucune occurrence', 'abcdef', 'absent', []],
  ['fichier vide', '', 'error', []]
]) {
  test(`scan : ${name}`, () => {
    for (const size of [1, 2, 3, 7, 64, 128, 1024]) {
      const hits = scan(text, needle, size)
      assert.deepEqual(hits.map(h => h.lineNo), lines, `chunkSize=${size}`)
      assert.ok(hits.every(h => h.line.length <= 200 && !h.line.includes('�')))
    }
  })
}
test('scan : aiguille dépassant l’ancien recouvrement fixe', () => {
  const needle = 'ab'.repeat(2500) + 'FIN'
  assert.deepEqual(scan('x\n' + needle + '\n', needle, 37).map(h => h.lineNo), [2])
})
test('scan : arrêt explicite après le premier match', () => {
  assert.equal(scan('ERROR error\nerror', 'error', 2, true).length, 1)
})
test('scan : aiguille vide et taille de bloc invalide', () => {
  assert.equal(scanText(file, ''), 0)
  assert.throws(() => scanText(file, 'x', { chunkSize: 0 }), /chunkSize/)
})

function context(hits, ctx) {
  const db = new Database(':memory:')
  try {
    db.exec(SCHEMA)
    const put = db.prepare('INSERT INTO events(id,session_id,ts,role,json) VALUES(?,?,?,?,?)')
    for (let i = 1; i <= 5; i++) {
      const e = { id: `m${i}`, sessionId: 's', ts: i === 3 ? 2 : i, role: 'user', text: `message ${i}` }
      put.run(e.id, e.sessionId, e.ts, e.role, JSON.stringify(e))
    }
    put.run('s', 's', 0, 'title', JSON.stringify({ id: 's', role: 'title' }))
    return inReadTx(db, () => neighborsBySessionDb(db, 's', hits.map(id => {
      const r = db.prepare('SELECT id,ts,role FROM events WHERE id=?').get(id)
      return r
    }), ctx).get('s'))
  } finally { db.close() }
}
test('contexte : hit central présent avec ses deux voisins', () => {
  const w = context(['m3'], 1)
  assert.deepEqual(w.evs.map(e => e.id), ['m2', 'm3', 'm4'])
  assert.deepEqual(w.absIdx, [1, 2, 3])
})
test('contexte : ctx=0 garde le hit', () => {
  assert.deepEqual(context(['m3'], 0).evs.map(e => e.id), ['m3'])
})
test('contexte : fenêtres fusionnées sans doubler les hits', () => {
  const w = context(['m3', 'm2'], 1)
  assert.deepEqual(w.evs.map(e => e.id), ['m1', 'm2', 'm3', 'm4'])
  assert.deepEqual(w.absIdx, [0, 1, 2, 3])
})
test('contexte : titre synthétique exclu de la séquence des messages', () => {
  const w = context(['s'], 2)
  assert.deepEqual(w.evs.map(e => e.id), ['m1', 'm2'])
  assert.deepEqual(w.absIdx, [0, 1])
})
