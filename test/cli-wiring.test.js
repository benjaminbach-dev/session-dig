// Lot 1 : raccordements CLI uniquement, corpus synthétique temporaire.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildFixtureDb } from './helpers/fixture.js'
import { ingest } from '../src/corpus.js'
import { rawShardPath } from '../src/layout.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-cli-wiring-'))
const root = path.join(tmp, 'corpus')
const source = path.join(tmp, 'source.db')
const cli = fileURLToPath(new URL('../bin/sdig.js', import.meta.url))
before(async () => { buildFixtureDb(source); await ingest({ root, db: source }) })
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function run(args, binary = false) {
  const r = spawnSync(process.execPath, [cli, ...args, '--home', root], {
    encoding: binary ? null : 'utf8', timeout: 8000, maxBuffer: 8 << 20
  })
  assert.ifError(r.error)
  assert.equal(r.status, 0, String(r.stderr))
  assert.equal(String(r.stderr), '')
  return r.stdout
}

test('CLI : help démarre avec tous les imports résolus', () => {
  assert.match(run(['--help']), /Usage:/)
})
test('CLI : recherche ordinaire utilise inReadTx', () => {
  assert.match(run(['proxy', '--plain']), /ses_fix1/)
})
test('CLI : recherche JSON termine sans erreur ni texte supplémentaire', () => {
  assert.doesNotThrow(() => JSON.parse(run(['proxy', '--json'])))
  assert.doesNotThrow(() => JSON.parse(run(['proxy', '--json', '--raw'])))
})
test('CLI : aucun résultat termine proprement', () => {
  assert.equal(run(['zzzzabsentlotun']), 'aucun résultat\n')
  assert.doesNotThrow(() => JSON.parse(run(['zzzzabsentlotun', '--json'])))
})
test('CLI : read est raccordé', () => {
  const out = JSON.parse(run(['read', 'ses_fix1', '--tail', '1', '--json']))
  assert.ok(out)
})
test('CLI : raw reproduit les octets sur plusieurs blocs', () => {
  const file = rawShardPath(path.join(root, 'raw'), 'prt_wiring')
  const bytes = Buffer.alloc((2 << 20) + 131)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  assert.deepEqual(run(['raw', 'prt_wiring'], true), bytes)
})
test('CLI : --raw atteint le scanner sans ancien export', () => {
  // Aucun diagnostic sur la justesse de scanText ici : réservée au lot 2.
  assert.equal(run(['zzzzabsentlotun', '--raw']), 'aucun résultat (ni index, ni sorties brutes)\n')
})
