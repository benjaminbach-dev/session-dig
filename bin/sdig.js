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
  sdig read <session> [--around <msgId>] [--ctx N] [--tail N] [--at <ancre>] [--full | --chars N] [--json]
                                dérouler une session autour d'un message, éventuellement
                                bornée dans le temps (--at : id de message, date, ou epoch ms)
  sdig raw <partId>            afficher une sortie d'outil brute (preuve)
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
  --ctx N        affiche N messages voisins autour de chaque hit (lecture du contexte)
  --at ANCRE     (read) borne la lecture à un instant : masque les messages postérieurs
                 à l'ancre (id de message de la session, AAAA-MM-JJ[THH:MM], ou epoch ms ;
                 une date seule garde la journée entière visible). L'ancre est rappelée et
                 le nombre de messages masqués est affiché — jamais de masquage silencieux.
                 Hors périmètre : aucune détection des changements d'état.
  --raw          cherche aussi dans les sorties brutes (stderr inclus)
  --full         texte intégral des messages (lève la limite d'affichage ; read, --ctx, hits)
  --chars N      limite d'affichage par message en caractères (défaut : 400 + 4 lignes)
  --json         sortie JSON (script/tests ; texte intégral des messages dans le champ text)
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
  const known = new Set(['repo', 'session', 'after', 'before', 'model', 'role', 'agent', 'limit', 'json', 'plain', 'home', 'db', 'rebuild', 'ctx', 'raw', 'around', 'tail', 'at', 'head', 'full', 'chars'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { flags.help = true; continue }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (!known.has(k)) fail(`option inconnue : ${a}\n\n${USAGE}`)
      if (k === 'json' || k === 'plain' || k === 'rebuild' || k === 'raw' || k === 'full') { flags[k] = true; continue }
      const v = argv[++i]
      if (v == null) fail(`option ${a} : valeur manquante`)
      flags[k] = v
    } else positional.push(a)
  }
  return { positional, flags }
}

function parseChars (flags) {
  if (!flags.chars) return null
  const n = parseInt(flags.chars, 10)
  if (!Number.isFinite(n) || n < 1) fail('--chars : nombre invalide')
  return n
}

async function main () {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); return }

  const sub = argv[0]
  const isSub = ['ingest', 'index', 'refresh', 'status', 'read', 'raw'].includes(sub)
  const { positional, flags } = parseArgs(isSub ? argv.slice(1) : argv)

  // --at (change add-read-at) n'existe que sur la lecture : la recherche borne par date
  // avec --after/--before, elle ne masque pas d'affichage.
  if (flags.at && !(isSub && sub === 'read')) {
    fail('--at : option de `sdig read` uniquement (pour la recherche, voir --after/--before)')
  }

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

  if (isSub && sub === 'read') {
    const sessionId = positional[0]
    if (!sessionId) fail('usage : sdig read <session> [--around <msgId>] [--ctx N] [--tail N] [--at <ancre>] [--full | --chars N] [--json]')
    const chars = parseChars(flags)
    const { sessionSlice } = await import('../src/read.js')
    const { renderRead, renderReadJson } = await import('../src/format.js')
    const slice = sessionSlice(paths.root, sessionId, {
      aroundId: flags.around,
      ctx: flags.ctx ? parseInt(flags.ctx, 10) : 10,
      tail: flags.tail ? parseInt(flags.tail, 10) : undefined,
      at: flags.at
    })
    if (!slice) fail(`session inconnue : ${sessionId} (préfixe accepté dans sdig --session, pas ici — id complet requis)`)
    // Ancre invalide : erreur explicite, sortie non nulle, aucune sortie partielle trompeuse.
    if (slice.fatal) fail(slice.error, 2)
    if (flags.json) { console.log(renderReadJson(slice, sessionId)); return }
    console.log(renderRead(slice, sessionId, { full: !!flags.full, chars, plain: !!flags.plain }))
    return
  }

  if (isSub && sub === 'raw') {
    const partId = positional[0]
    if (!partId) fail('usage : sdig raw <partId> (id de part, cf. rawRef dans les résultats)')
    const file = `${paths.raw}/${partId}.txt`
    if (!fs.existsSync(file)) fail(`sortie brute introuvable : ${file}`)
    const content = fs.readFileSync(file, 'utf8')
    if (flags.head) {
      const n = parseInt(flags.head, 10)
      if (!Number.isFinite(n) || n < 1) fail('--head : nombre invalide')
      console.log(content.split('\n').slice(0, n).join('\n'))
    } else {
      console.log(content)
    }
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
  if (!hits.length && !flags.raw) { console.log('aucun résultat'); return }
  const chars = parseChars(flags)
  const { sessionsById, events } = loadCorpus(paths.root)
  const prettify = hits.map(h => ({ ...h, role: h.role === 'title' ? 'titre' : h.role }))
  if (hits.length) {
    let ctxEvents = null
    if (flags.ctx) {
      const n = parseInt(flags.ctx, 10)
      if (!Number.isFinite(n) || n < 0) fail('--ctx : nombre invalide')
      const { eventsBySession } = await import('../src/read.js')
      ctxEvents = eventsBySession(events)
      console.log(renderTerminal(prettify, sessionsById, { ctx: n, eventsBySession: ctxEvents, plain: flags.plain, full: !!flags.full, chars }))
    } else {
      console.log(renderTerminal(prettify, sessionsById, { plain: flags.plain, full: !!flags.full, chars }))
    }
  }
  if (flags.raw) {
    const { rawScan } = await import('../src/raw.js')
    const { renderRawHits } = await import('../src/format.js')
    const matches = rawScan(paths.root, q, { limit: 10 })
    if (matches.length) console.log(renderRawHits(matches))
    else if (!hits.length) console.log('aucun résultat (ni index, ni sorties brutes)')
  }
}

main().catch(e => fail(e.message))
