// Smoke durable du banc synthétique (change scale-corpus, passe corrective 06/10/2026).
// Exerce `scripts/bench.js` à PETITE échelle : assertions de correction, rapport,
// preuve géante réelle, EXPLAIN, et nettoyage du répertoire temporaire. Vérifie
// aussi que les arguments invalides échouent AVANT toute création de tmp.
// Le GROS banc reste hors `npm test` (durée).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const CLI = fileURLToPath(new URL('../scripts/bench.js', import.meta.url))
const TIMEOUT = 120000

function run (args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT,
    maxBuffer: 32 << 20
  })
}

test('smoke : parcours complet petit, assertions, preuve géante, EXPLAIN, cleanup', () => {
  const r = run(['--n', '100', '--sessions', '5', '--runs', '3', '--raw-mib', '1'])
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}\n${r.stdout}`)
  const out = r.stdout
  assert.match(out, /banc : OK \(n=100, sessions=5, runs=3\)/, 'marqueur de succès')
  assert.match(out, /EXPLAIN QUERY PLAN — requêtes EXACTES de l’adaptateur/, 'plans SQL affichés')
  assert.match(out, /sessions fallback \(sans index time_updated\)/, 'requête sessions fallback expliquée')
  assert.match(out, /sessions keyset \(avec index time_updated\)/, 'requête sessions keyset expliquée')
  assert.match(out, /messages du delta \(groupés par session\)/, 'requête messages expliquée')
  assert.match(out, /octets UTF-8 rendus/, 'rendu recherche mesuré en octets UTF-8')
  assert.match(out, /preuve géante : .*bytes\/hash EXACTS/, 'preuve géante vérifiée (bytes/hash exacts)')
  assert.match(out, /pic RSS OS cumulatif \(process\.resourceUsage\(\)\.maxRSS\)/, 'pic RSS OS cumulatif')
  assert.match(out, /read --at \(streamRead → sink hash\)/, 'lecture en flux mesurée')
  assert.match(out, /recherche rendue \(\+voisins, tx\)/, 'recherche rendue mesurée')
  assert.match(out, /pi append \(1 msg dans le gros fichier\)/, 'phase pi changé mesurée')

  // Nettoyage : le tmp annoncé doit avoir été supprimé.
  const m = out.match(/tmp : (\S+)/)
  assert.ok(m, 'chemin tmp annoncé')
  assert.equal(fs.existsSync(m[1]), false, `tmp supprimé : ${m[1]}`)
  assert.match(out, new RegExp(`nettoyage : ${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} supprimé`), 'ligne de nettoyage')
})

test('smoke : --keep conserve explicitement le répertoire', () => {
  const r = run(['--n', '100', '--sessions', '4', '--runs', '3', '--raw-mib', '1', '--keep'])
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`)
  const m = r.stdout.match(/tmp : (\S+)/)
  assert.ok(m)
  try {
    assert.equal(fs.existsSync(m[1]), true, '--keep conserve le tmp')
  } finally {
    fs.rmSync(m[1], { recursive: true, force: true })
  }
})

test('smoke : arguments invalides refusés AVANT toute création de tmp', () => {
  for (const [args, motif] of [
    [['--n', '0'], /--n : valeur hors bornes/],
    [['--n', '100', '--runs', '1'], /--runs : valeur hors bornes/],
    [['--n', '100', '--raw-mib', '0'], /--raw-mib : valeur hors bornes/],
    [['--n', '10', '--sessions', '100'], /--sessions : trop de sessions/],
    [['--n', '10', '--sessions', 'abc'], /--sessions : entier positif attendu/],
    [['--n', '100', '--n', '200'], /--n : option répétée/],
    [['--n', '100', '--seed', '4294967296'], /--seed : valeur hors bornes/],
    [['--n', '100', '--raw-mib', '100000'], /--raw-mib : valeur hors bornes/],
    [['--inconnu'], /option inconnue/],
    [['positionnel'], /argument positionnel refusé/]
  ]) {
    const r = run(args)
    assert.equal(r.status, 2, `args ${args.join(' ')} → exit ${r.status}`)
    assert.match(r.stderr, motif)
    assert.ok(!/tmp :/.test(r.stdout), 'aucun tmp créé/annoncé avant validation')
  }
})

test('smoke : --help n’exécute rien', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage: node scripts\/bench\.js/)
  assert.ok(!/tmp :/.test(r.stdout))
})
