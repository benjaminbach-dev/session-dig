// Tests de scripts/audit-toolcalls.mjs (change update-natural-eval, ADDED « Audit
// déterministe des accès »). Fixtures synthétiques : jamais de données réelles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  MOTIFS, MOTIFS_FINGERPRINT, matchMotifs, isLegitSdigSegment, extractTarget, commandFromRaw,
  auditResponses, auditDir, renderMarkdown
} from '../scripts/audit-toolcalls.mjs'

// Forme réelle d'un appel d'outil : `input` = état opencode encodé en JSON.
const bash = command => ({ tool: 'bash', input: JSON.stringify({ status: 'completed', input: { command }, output: '…' }) })
const response = (id, commands, extra = {}) => ({ id, question: `question ${id}`, answer: `réponse ${id}`, toolCalls: commands.map(bash), ...extra })

test('lecture directe d\'un fichier du corpus : listée', () => {
  const r = auditResponses([response('n12', ['cat /root/.local/share/session-dig/events.jsonl | python3 -c "…"'])])
  assert.equal(r.deviations.length >= 1, true)
  assert.ok(r.deviations.some(d => d.motifs.includes('corpus-events')))
  assert.ok(r.deviations.some(d => d.motifs.includes('corpus-root')))
  assert.deepEqual(r.questions, ['n12'])
  assert.equal(r.invalidating, 0)
})

test('ouverture sqlite : listée (sqlite3 et better-sqlite3)', () => {
  const a = auditResponses([response('n01', ["sqlite3 /root/.local/share/session-dig/index.db 'select id from docs limit 5'"])])
  assert.ok(a.deviations.some(d => d.motifs.includes('sqlite')))
  assert.ok(a.deviations.some(d => d.motifs.includes('index-db')))
  const b = auditResponses([response('n02', ['node -e "const D=require(\'better-sqlite3\');new D(\'opencode.db\')"'])])
  assert.ok(b.deviations.some(d => d.motifs.includes('sqlite')))
  assert.ok(b.deviations.some(d => d.motifs.includes('opencode-db')))
})

test('invocations sdig légitimes : zéro faux positif', () => {
  const r = auditResponses([response('n03', [
    'sdig --help 2>&1 | head -50',
    'sdig read ses_fix1 --around msg_1 --ctx 3 --full',
    'sdig raw part_17',
    'sdig "bug proxy 461" --repo ks-agent --limit 10',
    'sdig status',
    'sdig index',
    'sdig "pourquoi opencode.db est verrouillé" --json', // requête qui cite un nom de fichier : légitime
    'cd /root/session-dig && sdig refresh-free-zone' // sous-chaîne « refresh » sans être une sous-commande
  ])])
  assert.deepEqual(r.deviations, [])
  assert.equal(r.scanned, 1)
})

test('état d\'outil tronqué : la sortie qui cite le corpus n\'est pas une déviation', () => {
  // Forme réelle des runs : l'état est coupé, JSON.parse échoue, et la sortie de
  // `sdig status` imprime le chemin du corpus. Le champ commande seul est analysé.
  const truncated = '{"status":"completed","input":{"command":"sdig status 2>&1 | head -5"},"output":"50\\ncorpus   : /root/.local/share/session-dig\\nsessions : 233'
  assert.throws(() => JSON.parse(truncated)) // JSON invalide, comme en vrai
  const r = auditResponses([{ id: 'n10', question: 'q', answer: 'a', toolCalls: [{ tool: 'bash', input: truncated }] }])
  assert.deepEqual(r.deviations, [])
  assert.equal(extractTarget({ tool: 'bash', input: truncated }).text, 'sdig status 2>&1 | head -5')
})

test('phrase entre guillemets contenant un mot-clé : pas une déviation', () => {
  const r = auditResponses([response('n11', [
    'for q in "brave" "tavily" "sqlite leur" "server MCP"; do sdig "$q" --json; done',
    'grep -i "opencode.db verrouillé" /tmp/notes.txt'
  ])])
  assert.deepEqual(r.deviations, [])
})

test('corps de script entre guillemets : détecté (ce n\'est pas une phrase)', () => {
  const r = auditResponses([response('n14', [
    `python3 -c "import sqlite3, os; c=sqlite3.connect('file:'+os.path.expanduser('~/.local/share/session-dig/index.db')+'?mode=ro')"`
  ])])
  assert.ok(r.deviations.some(d => d.motifs.includes('sqlite')))
  assert.ok(r.deviations.some(d => d.motifs.includes('index-db')))
})

test('chemin entre guillemets sans espace : reste détecté', () => {
  const r = auditResponses([response('n13', ['cat "/root/.local/share/session-dig/events.jsonl" | head -3'])])
  assert.ok(r.deviations.some(d => d.motifs.includes('corpus-events')))
})

test('sdig ingest / refresh : listés comme écriture du corpus', () => {
  const r = auditResponses([response('n04', ['sdig ingest', 'sdig --corpus /root/.local/share/session-dig refresh'])])
  assert.equal(r.deviations.filter(d => d.motifs.includes('sdig-mutation')).length, 2)
})

test('lecture du jeu de test : listée et invalidante', () => {
  const r = auditResponses([response('n05', ['cat eval/natural/questions.jsonl'])])
  assert.equal(r.invalidating >= 1, true)
  assert.ok(r.deviations.some(d => d.motifs.includes('playbook') && d.invalidating))
})

test('run sain : aucune déviation, formulation qui rappelle la limite du filet', () => {
  const r = auditResponses([response('n06', ['sdig read ses_x --tail 20']), response('n07', ['sdig "quota cli"'], { recovered: true })])
  assert.deepEqual(r.deviations, [])
  assert.equal(r.scanned, 2)
  assert.equal(r.recovered, 1)
  const md = renderMarkdown({ ...r, label: 'run-test' })
  assert.match(md, /Aucune déviation détectée/)
  assert.match(md, /pas la preuve que rien n'a eu lieu/i)
  assert.match(md, /Motifs épinglés : \*\*8\*\*/)
})

test('une ligne par déviation : question, outil, motif, extrait, résumé final', () => {
  const r = auditResponses([response('n08', ['ls -la /root/.local/share/session-dig/raw/ | tail -5'])])
  const md = renderMarkdown({ ...r, label: 'run-test' })
  const lines = md.split('\n').filter(l => l.startsWith('| n08 '))
  assert.equal(lines.length >= 1, true)
  assert.match(lines[0], /^\| n08 \| bash \| corpus-root \| `.*` \| réponse n08 \|$/)
})

test('découpage et exemption des segments', () => {
  assert.equal(isLegitSdigSegment('sdig read ses_a'), true)
  assert.equal(isLegitSdigSegment('VAR=1 sdig raw part_1'), true)
  assert.equal(isLegitSdigSegment('sdig ingest'), false)
  assert.equal(isLegitSdigSegment('cat events.jsonl'), false)
  // La commande entière reste testée pour l'écriture, même noyée dans un pipeline.
  assert.ok(matchMotifs('echo ok && sdig ingest > /tmp/x').some(h => h.motif === 'sdig-mutation'))
})

test('extraction tolérante du texte d\'un appel', () => {
  assert.equal(extractTarget(bash('sdig status')).text, 'sdig status')
  assert.equal(extractTarget({ tool: 'bash', input: 'sdig status' }).text, 'sdig status') // JSON invalide : brut
  assert.equal(extractTarget({ tool: 'read', input: JSON.stringify({ input: { filePath: '/x/events.jsonl' } }) }).text, '/x/events.jsonl')
  assert.equal(extractTarget(undefined).text, '')
})

test('auditDir : ignore manifest.json, lit chaque réponse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-'))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id: 'n01', ok: true }]))
  fs.writeFileSync(path.join(dir, 'n01.json'), JSON.stringify(response('n01', ['sdig status'])))
  fs.writeFileSync(path.join(dir, 'n02.json'), JSON.stringify(response('n02', ['sqlite3 index.db .tables'])))
  const r = auditDir(dir)
  assert.equal(r.scanned, 2)
  assert.equal(r.files.length, 2) // manifest.json exclu
  assert.ok(r.deviations.every(d => d.id === 'n02'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('auditDir : dossier absent ou vide → erreur explicite', () => {
  assert.throws(() => auditDir('/tmp/nope-sdig-audit-xyz'), /dossier introuvable/)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-empty-'))
  assert.throws(() => auditDir(empty), /aucun JSON/)
  fs.rmSync(empty, { recursive: true, force: true })
})

test('motifs épinglés : gelés, identifiants uniques, empreinte stable', () => {
  assert.equal(Object.isFrozen(MOTIFS), true)
  const ids = MOTIFS.map(m => m.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length, 8)
  assert.match(MOTIFS_FINGERPRINT, /^[0-9a-f]{16}$/)
  // L'empreinte figure dans le rendu : deux audits ne se comparent que si elle coïncide.
  const md = renderMarkdown({ ...auditResponses([], { label: 'vide' }), label: 'vide' })
  assert.ok(md.includes(MOTIFS_FINGERPRINT))
})

test('CLI : rendu, --json, --strict (exit 1) et --motifs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-cli-'))
  fs.writeFileSync(path.join(dir, 'n09.json'), JSON.stringify(response('n09', ['sqlite3 opencode.db ".tables"'])))
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'audit-toolcalls.mjs')
  const run = args => { try { return { code: 0, out: execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) { return { code: e.status, out: String(e.stdout) } } }
  assert.equal(run([dir]).code, 0)                    // audit rendu, avec déviations
  assert.equal(run([dir, '--strict']).code, 1)        // --strict signale
  const json = JSON.parse(run([dir, '--json']).out)
  assert.equal(json.deviations[0].id, 'n09')
  assert.match(run(['--motifs']).out, /opencode-db/)
  assert.equal(run([]).code, 2)                        // usage
  fs.rmSync(dir, { recursive: true, force: true })
})
