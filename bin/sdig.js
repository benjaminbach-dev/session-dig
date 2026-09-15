#!/usr/bin/env node
// sdig — archéologie de sessions opencode (corpus JSONL canonique + BM25/FTS5).
import { ingest, loadCorpus } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { corpusPaths, sourceDb, corpusRoot } from '../src/paths.js'
import { renderTerminal, renderJson, renderStatus } from '../src/format.js'
import { parseDateBound } from '../src/util.js'
import fs from 'node:fs'

const USAGE = `sdig — archéologie de sessions opencode

Usage:
  sdig <requête> [filtres]     recherche (commande par défaut)
  sdig ingest [--db P] [--rebuild]   source → corpus (incrémental par défaut)
  sdig index                          corpus → index BM25 (rebuild complet)
  sdig refresh                        ingest + index
  sdig status                         état du corpus et de l'index

Filtres de recherche :
  --repo R       repo exact (basename du répertoire de session)
  --session S    id de session (préfixe accepté)
  --after DATE   à partir de (2026, 2026-06, 2026-06-01 ou ISO)
  --before DATE  jusqu'à (incluse)
  --model M      sous-chaîne (ex: deepseek, opencode/big-pickle)
  --role R       user | assistant
  --agent A      agent exact (build, plan...)
  --limit N      défaut 20
  --json         sortie JSON (script/tests)
  --plain        highlight sans ANSI

Global :
  --home P       racine corpus (défaut ~/.local/share/session-dig, env SESSION_DIG_HOME)
  --db P         base opencode (défaut ~/.local/share/opencode/opencode.db, env SESSION_DIG_DB)`

function fail (msg, code = 1) {
  console.error(`sdig: ${msg}`)
  process.exit(code)
}

function parseArgs (argv) {
  const positional = []
  const flags = {}
  const known = new Set(['repo', 'session', 'after', 'before', 'model', 'role', 'agent', 'limit', 'json', 'plain', 'home', 'db', 'rebuild'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { flags.help = true; continue }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (!known.has(k)) fail(`option inconnue : ${a}\n\n${USAGE}`)
      if (k === 'json' || k === 'plain' || k === 'rebuild') { flags[k] = true; continue }
      const v = argv[++i]
      if (v == null) fail(`option ${a} : valeur manquante`)
      flags[k] = v
    } else positional.push(a)
  }
  return { positional, flags }
}

async function main () {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); return }

  const sub = argv[0]
  const isSub = ['ingest', 'index', 'refresh', 'status'].includes(sub)
  const { positional, flags } = parseArgs(isSub ? argv.slice(1) : argv)

  if (flags.home) process.env.SESSION_DIG_HOME = flags.home
  if (flags.db) process.env.SESSION_DIG_DB = flags.db
  const paths = corpusPaths(corpusRoot())

  if (isSub && sub === 'ingest') {
    const r = await ingest({ root: paths.root, db: flags.db, rebuild: flags.rebuild })
    console.log(`ingest ${r.rebuild ? '(rebuild)' : '(incrémental)'} : +${r.added} events (${r.updated} maj, ${r.unchanged} inchangés), +${r.sessionsAdded} sessions (${r.sessionsUpdated} maj) → ${r.totals.events} events / ${r.totals.sessions} sessions, ${r.rawWritten} raw écrit(s)`)
    return
  }

  if (isSub && sub === 'index') {
    if (!fs.existsSync(paths.events)) fail('corpus absent — lancer `sdig ingest` d\'abord')
    const r = index(paths.root)
    console.log(`index bm25 : ${r.events} event(s) indexé(s) → ${r.dbFile}`)
    return
  }

  if (isSub && sub === 'refresh') {
    const r1 = await ingest({ root: paths.root, db: flags.db, rebuild: flags.rebuild })
    const r2 = index(paths.root)
    console.log(`refresh : +${r1.added}/${r1.updated} events → corpus ${r1.totals.events}, index ${r2.events}`)
    return
  }

  if (isSub && sub === 'status') {
    let st
    try { st = JSON.parse(fs.readFileSync(paths.state, 'utf8')) } catch { fail('corpus absent — lancer `sdig ingest` d\'abord') }
    let rawFiles = 0
    try { rawFiles = fs.readdirSync(paths.raw).length } catch {}
    let idx = null
    if (fs.existsSync(paths.index)) {
      const Database = (await import('better-sqlite3')).default
      const idb = new Database(paths.index, { readonly: true })
      try { idx = { events: idb.prepare('SELECT COUNT(*) n FROM events').get().n, mtime: fs.statSync(paths.index).mtimeMs } } finally { idb.close() }
    }
    const counts = st.counts || { sessions: 0, events: 0 }
    console.log(renderStatus({ counts, rawFiles, watermark: { message: st.message ?? 0, session: st.session ?? 0 }, index: idx }, paths))
    return
  }

  // ── recherche (défaut) ──
  const q = positional.join(' ')
  if (!q) fail('requête manquante\n\n' + USAGE)
  if (!fs.existsSync(paths.index)) fail('index absent — lancer `sdig refresh` d\'abord')
  const after = flags.after ? parseDateBound(flags.after, false) : null
  const before = flags.before ? parseDateBound(flags.before, true) : null
  if (flags.after && after == null) fail(`--after : date invalide (${flags.after})`)
  if (flags.before && before == null) fail(`--before : date invalide (${flags.before})`)
  const limit = flags.limit ? parseInt(flags.limit, 10) : 20
  if (!Number.isFinite(limit) || limit < 1) fail('--limit : nombre invalide')

  const hits = search(paths.index, {
    q, repo: flags.repo, session: flags.session, after, before,
    model: flags.model, role: flags.role, agent: flags.agent,
    limit, plain: flags.plain || flags.json
  })
  if (flags.json) { console.log(renderJson(hits)); return }
  if (!hits.length) { console.log('aucun résultat'); return }
  const { sessionsById } = loadCorpus(paths.root)
  console.log(renderTerminal(hits, sessionsById))
}

main().catch(e => fail(e.message))
