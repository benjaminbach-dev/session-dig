// Tests de scripts/audit-toolcalls.mjs (change update-natural-eval, ADDED « Audit
// déterministe des accès »). Fixtures synthétiques : jamais de données réelles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  MOTIFS, MOTIFS_FINGERPRINT, matchMotifs, analyseCommand, parseSegment, segments,
  extractTarget, commandFromRaw, auditResponses, auditDir, renderMarkdown
} from '../scripts/audit-toolcalls.mjs'

// Forme réelle d'un appel d'outil : `input` = état opencode encodé en JSON.
const bash = command => ({ tool: 'bash', input: JSON.stringify({ status: 'completed', input: { command }, output: '…' }) })
const response = (id, commands, extra = {}) => ({ id, question: `question ${id}`, answer: `réponse ${id}`, toolCalls: commands.map(bash), ...extra })
const deviationsOf = commands => auditResponses([response('nX', commands)]).deviations
const motifsOf = commands => [...new Set(deviationsOf(commands).flatMap(d => d.motifs))]

test('lecture directe d\'un fichier du corpus : listée', () => {
  const r = auditResponses([response('n12', ['cat /root/.local/share/session-dig/events.jsonl | python3 -c "…"'])])
  assert.equal(r.deviations.length, 1)
  assert.ok(r.deviations[0].motifs.includes('corpus-events'))
  assert.ok(r.deviations[0].motifs.includes('corpus-root'))
  assert.deepEqual(r.questions, ['n12'])
  assert.equal(r.invalidating, 0)
  assert.equal(r.status, 'complete')
})

// --- Point 1 : la commande réellement invoquée, pas la présence du mot ---------

test('`grep sdig events.jsonl` : accès direct signalé (le mot sdig ne suffit pas)', () => {
  assert.ok(motifsOf(['grep sdig events.jsonl']).includes('corpus-events'))
  assert.ok(motifsOf(['grep -c sdig /root/.local/share/session-dig/sessions.jsonl']).includes('corpus-sessions'))
  // …et un vrai appel sdig reste propre.
  assert.deepEqual(deviationsOf(['sdig "events.jsonl" --limit 5']), [])
})

test('`sdig search "ingest"` : recherche légitime, pas une écriture', () => {
  assert.deepEqual(deviationsOf(['sdig search "ingest"']), [])
  assert.deepEqual(deviationsOf(['sdig --json read ses_x --tail 20']), [])
  assert.deepEqual(deviationsOf(['sdig index']), [])
  assert.deepEqual(deviationsOf(['sdig refresh-free-zone']), [])
  assert.deepEqual(deviationsOf(['sdig "meilleur des mondes" --limit 5']), [])
})

test('guillemets retirés par le shell : `sdig "ingest"` EST `sdig ingest`', () => {
  assert.ok(motifsOf(['sdig "ingest"']).includes('sdig-mutation'))
  assert.ok(motifsOf(["sdig 'refresh'"]).includes('sdig-mutation'))
  assert.ok(motifsOf(['sdig \"ingest\" --corpus /tmp/x']).includes('sdig-mutation'))
  // Sous-commande variable : valeur invisible → « à examiner », ni propre ni coupable.
  const r = analyseCommand('for q in "ingest" "search"; do sdig "$q" --json; done')
  assert.equal(r.hits.length, 0)
  assert.ok(r.review.some(n => /sous-commande sdig variable/.test(n.reason)))
})

test('`sdig read ses_x < events.jsonl` : redirection = lecture directe signalée', () => {
  const d = deviationsOf(['sdig read ses_x < events.jsonl'])
  assert.equal(d.length, 1)
  assert.ok(d[0].motifs.includes('corpus-events'))
  assert.ok(deviationsOf(['sdig read ses_x < /root/.local/share/session-dig/events.jsonl']).length === 1)
  // Une redirection vers /dev/null ou une duplication de fd n'est pas une déviation.
  assert.deepEqual(deviationsOf(['sdig status 2>&1 | head -5']), [])
  assert.deepEqual(deviationsOf(['sdig read ses_x > /tmp/out.txt']), [])
})

test('redirection vers un fichier du jeu de test : ouverture réelle, donc invalidante', () => {
  const r = auditResponses([response('n14', ['sdig search proxy < eval/natural/questions.jsonl'])])
  assert.equal(r.deviations.length, 1)
  assert.ok(r.deviations[0].motifs.includes('playbook'))
  assert.equal(r.invalidating, 1)
  // Alors qu'un nom du jeu cité comme requête (sans redirection) reste innocent.
  assert.deepEqual(deviationsOf(['sdig search "questions.jsonl"']), [])
})

test('chemin passé en argument positionnel à sdig : signalé', () => {
  const d = deviationsOf(['sdig read ses_x /root/.local/share/session-dig/events.jsonl'])
  assert.equal(d.length, 1)
  assert.ok(d[0].motifs.includes('corpus-events'))
})

test('sous-commandes mutantes : reconnues même avec options en préfixe', () => {
  assert.ok(motifsOf(['sdig ingest']).includes('sdig-mutation'))
  assert.ok(motifsOf(['sdig --corpus /root/.local/share/session-dig refresh']).includes('sdig-mutation'))
  assert.ok(motifsOf(['echo ok && sdig ingest > /tmp/x']).includes('sdig-mutation'))
  // Option pointant un chemin : ni propre ni coupable → « à examiner ».
  const r = analyseCommand('sdig --corpus /root/.local/share/session-dig read ses_x')
  assert.equal(r.hits.length, 0)
  assert.ok(r.review.some(n => /option sdig/.test(n.reason)))
})

test('commandes dynamiques : « à examiner », pas condamnées', () => {
  const r = analyseCommand('$(which sdig) read ses_x')
  assert.ok(r.review.length >= 1)
  const r2 = analyseCommand('xargs sdig read')
  assert.ok(r2.review.some(n => /dynamique/.test(n.reason)))
  assert.deepEqual(r2.hits, [])
})

test('reconnaissance du segment invoqué (parseSegment)', () => {
  const p = parseSegment('sdig read ses_x < events.jsonl')
  assert.equal(p.bin, 'sdig')
  assert.equal(p.subcommand, 'read')
  assert.deepEqual(p.redirections.map(r => r.target), ['events.jsonl'])
  assert.equal(parseSegment('sdig "ingest"').quotedSub, true)
  assert.equal(parseSegment('VAR=1 sudo sdig raw part_1').bin, 'sdig')
  assert.equal(parseSegment('for q in "a" "b"').kind, 'keyword')
  assert.equal(parseSegment('import sqlite3, os').bin, 'import') // corps de heredoc analysé
  assert.equal(segments('a | b && c').length, 3)
})

test('ouverture sqlite : listée (sqlite3 et better-sqlite3)', () => {
  const a = auditResponses([response('n01', ["sqlite3 /root/.local/share/session-dig/index.db 'select id from docs limit 5'"])])
  assert.ok(a.deviations[0].motifs.includes('sqlite'))
  assert.ok(a.deviations[0].motifs.includes('index-db'))
  const b = auditResponses([response('n02', ['node -e "const D=require(\'better-sqlite3\');new D(\'opencode.db\')"'])])
  assert.ok(b.deviations[0].motifs.includes('sqlite'))
  assert.ok(b.deviations[0].motifs.includes('opencode-db'))
  // Heredoc : les lignes du corps sont analysées (bin = import).
  const c = auditResponses([response('n03', ["python3 - <<'EOF'\nimport sqlite3, os\nEOF"])])
  assert.ok(c.deviations[0].motifs.includes('sqlite'))
})

test('état d\'outil tronqué : la sortie qui cite le corpus n\'est pas une déviation', () => {
  const truncated = '{"status":"completed","input":{"command":"sdig status 2>&1 | head -5"},"output":"50\\ncorpus   : /root/.local/share/session-dig\\nsessions : 233'
  assert.throws(() => JSON.parse(truncated))
  const r = auditResponses([{ id: 'n10', question: 'q', answer: 'a', toolCalls: [{ tool: 'bash', input: truncated }] }])
  assert.deepEqual(r.deviations, [])
  assert.equal(extractTarget({ tool: 'bash', input: truncated }).text, 'sdig status 2>&1 | head -5')
})

test('citations : phrases masquées, corps de script conservés', () => {
  assert.deepEqual(deviationsOf([
    'for q in "brave" "tavily" "sqlite leur" "server MCP"; do sdig "$q" --json; done',
    'grep -i "opencode.db verrouillé" /tmp/notes.txt'
  ]), [])
  assert.ok(motifsOf([`python3 -c "import sqlite3, os; c=sqlite3.connect('file:'+os.path.expanduser('~/.local/share/session-dig/index.db')+'?mode=ro')"`]).includes('index-db'))
  assert.ok(motifsOf(['cat "/root/.local/share/session-dig/events.jsonl" | head -3']).includes('corpus-events'))
})

test('lecture du jeu de test : listée et invalidante — mais pas en argument de sdig', () => {
  const r = auditResponses([response('n05', ['cat eval/natural/questions.jsonl'])])
  assert.equal(r.invalidating, 1)
  assert.ok(r.deviations.some(d => d.motifs.includes('playbook') && d.invalidating))
  assert.deepEqual(deviationsOf(['sdig search "questions.jsonl"']), [])
})

test('run sain : aucune déviation, statut complet, limite du filet rappelée', () => {
  const r = auditResponses([response('n06', ['sdig read ses_x --tail 20']), response('n07', ['sdig "quota cli"'], { recovered: true })])
  assert.deepEqual(r.deviations, [])
  assert.equal(r.scanned, 2)
  assert.equal(r.recovered, 1)
  assert.equal(r.calls, 2)
  assert.equal(r.status, 'complete')
  const md = renderMarkdown({ ...r, label: 'run-test' })
  assert.match(md, /Aucune déviation détectée/)
  assert.match(md, /pas la preuve que rien n'a eu lieu/i)
  assert.match(md, /Motifs épinglés : \*\*8\*\*/)
  assert.match(md, /audit complet/)
})

test('une ligne par déviation : question, outil, motif, extrait, résumé final', () => {
  const r = auditResponses([response('n08', ['ls -la /root/.local/share/session-dig/raw/ | tail -5'])])
  const md = renderMarkdown({ ...r, label: 'run-test' })
  const lines = md.split('\n').filter(l => l.startsWith('| n08 '))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\| n08 \| bash \| corpus-root \| `.*` \| réponse n08 \|$/)
})

// --- Point 2 : une entrée illisible n'est pas un audit propre ------------------

test('entrée illisible : comptée, listée, statut « audit incomplet »', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-broken-'))
  fs.writeFileSync(path.join(dir, 'n01.json'), JSON.stringify(response('n01', ['sdig status'])))
  fs.writeFileSync(path.join(dir, 'n02.json'), '{"id":"n02","toolCalls":[') // JSON tronqué
  const r = auditDir(dir)
  assert.equal(r.status, 'incomplete')
  assert.equal(r.unreadable.length, 1)
  assert.match(r.unreadable[0].file, /n02\.json/)
  assert.equal(r.scanned, 1)
  assert.equal(r.responses, 2)
  const md = renderMarkdown(r)
  assert.match(md, /AUDIT INCOMPLET/)
  assert.match(md, /JSON illisible/)
  assert.match(md, /Entrées non analysables/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('appel sans commande extractible : compté comme non analysable', () => {
  const r = auditResponses([{ id: 'n09', question: 'q', answer: 'a', toolCalls: [{ tool: 'read', input: '{}' }, { tool: 'bash' }] }])
  assert.equal(r.unanalysable.length, 2)
  assert.equal(r.status, 'incomplete')
  assert.equal(r.deviations.length, 0)
  assert.match(renderMarkdown(r), /appel sans commande extractible/)
})

test('auditDir : ignore manifest.json, entrée sans identifiant comptée illisible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-'))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ id: 'n01', ok: true }]))
  fs.writeFileSync(path.join(dir, 'n01.json'), JSON.stringify(response('n01', ['sdig status'])))
  fs.writeFileSync(path.join(dir, 'n02.json'), JSON.stringify(response('n02', ['sqlite3 index.db .tables'])))
  fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ question: 'sans id' }))
  const r = auditDir(dir)
  assert.equal(r.responses, 3) // manifest.json exclu
  assert.equal(r.scanned, 2)
  assert.equal(r.status, 'incomplete')
  assert.ok(r.deviations.every(d => d.id === 'n02'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('auditDir : dossier absent ou vide → erreur explicite', () => {
  assert.throws(() => auditDir('/tmp/nope-sdig-audit-xyz'), /dossier introuvable/)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-empty-'))
  assert.throws(() => auditDir(empty), /aucun JSON/)
  fs.rmSync(empty, { recursive: true, force: true })
})

test('extraction tolérante du texte d\'un appel', () => {
  assert.equal(extractTarget(bash('sdig status')).text, 'sdig status')
  assert.equal(extractTarget({ tool: 'bash', input: 'sdig status' }).text, 'sdig status') // JSON invalide : brut
  assert.equal(extractTarget({ tool: 'read', input: JSON.stringify({ input: { filePath: '/x/events.jsonl' } }) }).text, '/x/events.jsonl')
  assert.equal(extractTarget(undefined).text, '')
  assert.equal(commandFromRaw('{"input":{"command":"sdig status"'), 'sdig status')
  assert.equal(commandFromRaw('{"output":"bruit /root/.local/share/session-dig"}'), null)
})

test('motifs épinglés : gelés, identifiants uniques, empreinte stable', () => {
  assert.equal(Object.isFrozen(MOTIFS), true)
  const ids = MOTIFS.map(m => m.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length, 8)
  assert.match(MOTIFS_FINGERPRINT, /^[0-9a-f]{16}$/)
  const md = renderMarkdown({ ...auditResponses([], { label: 'vide' }), label: 'vide' })
  assert.ok(md.includes(MOTIFS_FINGERPRINT))
  assert.equal(matchMotifs('sdig ingest').length, 1)
})

test('CLI : rendu, --json, --strict (exit 1), --motifs, usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-cli-'))
  fs.writeFileSync(path.join(dir, 'n09.json'), JSON.stringify(response('n09', ['sqlite3 opencode.db ".tables"'])))
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-cli-ok-'))
  fs.writeFileSync(path.join(ok, 'n10.json'), JSON.stringify(response('n10', ['sdig read ses_x'])))
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'sdig-audit-cli-broken-'))
  fs.writeFileSync(path.join(broken, 'n11.json'), '{oops')
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'audit-toolcalls.mjs')
  const run = args => { try { return { code: 0, out: execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) { return { code: e.status, out: String(e.stdout) } } }
  assert.equal(run([dir]).code, 0)                       // audit rendu, même avec déviations
  assert.equal(run([dir, '--strict']).code, 1)           // --strict signale les déviations
  assert.equal(run([ok, '--strict']).code, 0)            // run propre : exit 0
  assert.equal(run([broken, '--strict']).code, 1)        // entrée illisible : audit incomplet
  const json = JSON.parse(run([dir, '--json']).out)
  assert.equal(json.deviations[0].id, 'n09')
  assert.equal(json.status, 'complete')
  assert.match(run(['--motifs']).out, /opencode-db/)
  assert.equal(run([]).code, 2)
  for (const d of [dir, ok, broken]) fs.rmSync(d, { recursive: true, force: true })
})
