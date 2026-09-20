#!/usr/bin/env node
// sdig — archéologie de sessions opencode (corpus JSONL canonique + BM25/FTS5).
// change scale-corpus : corpus v2 (shards par session), vue dérivable = chemin de
// lecture unique, preuves brutes shardées et lues par blocs, empreinte, migration.
import { ingest, migrate, fingerprint, proofWarning, recover } from '../src/corpus.js'
import { index, search } from '../src/retriever/bm25.js'
import { corpusPaths, sourceDb, corpusRoot } from '../src/paths.js'
import { openView, viewPath, viewIsCurrent } from '../src/view.js'
import { rawShardPath } from '../src/layout.js'
import { renderTerminal, renderJson, renderStatus, renderFingerprint } from '../src/format.js'
import { parseDateBound, streamBlocks } from '../src/util.js'
import { eventsBySessionDb } from '../src/read.js'
import { rawScan } from '../src/raw.js'
import fs from 'node:fs'
import Database from 'better-sqlite3'

const USAGE = `sdig — archéologie de sessions opencode

Usage:
  sdig <requête> [filtres]     recherche (commande par défaut)
  sdig read <session> [--around <msgId>] [--ctx N] [--tail N] [--at <ancre>] [--full | --chars N] [--json]
                                dérouler une session autour d'un message, éventuellement
                                bornée dans le temps (--at : id de message, date, ou epoch ms)
  sdig raw <partId>            afficher une sortie d'outil brute (preuve, lecture par blocs)
  sdig ingest [--db P] [--rebuild] [--recover]
                                source → corpus (incrémental par défaut ; --recover :
                                reprise explicite sans source, décision d'opérateur)
  sdig migrate                 corpus v1 → layout v2, sans la source (en flux, vérifiée)
  sdig fingerprint             empreinte déterministe du corpus (md5 agrégé, chemins triés)
  sdig index                   corpus → vue/index BM25 (rebuild complet)
  sdig refresh                 ingest + index
  sdig status                  état du corpus et de la vue

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
                 à l'ancre (id de message de la session, AAAA-MM-JJ[THH:MM] en UTC, ou
                 epoch ms ; une date seule garde la journée entière visible). Un horodatage
                 à la minute se place à :00 de cette minute — pour viser un message précis,
                 donner son id ou son epoch ms. Horodatage calendairement valide exigé —
                 2026-02-30 ou 25:00 sont refusés, jamais reportés en silence ; ancre vide
                 = erreur. L'ancre est rappelée et le nombre de messages masqués est
                 affiché (jamais de masquage silencieux).
                 Hors périmètre : aucune détection des changements d'état.
  --raw          cherche aussi dans les sorties brutes (stderr inclus ; scan en flux
                 par blocs — coût O(volume de raw/), durée affichée)
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
  const known = new Set(['repo', 'session', 'after', 'before', 'model', 'role', 'agent', 'limit', 'json', 'plain', 'home', 'db', 'rebuild', 'ctx', 'raw', 'around', 'tail', 'at', 'head', 'full', 'chars', 'recover'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { flags.help = true; continue }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (!known.has(k)) fail(`option inconnue : ${a}\n\n${USAGE}`)
      if (k === 'json' || k === 'plain' || k === 'rebuild' || k === 'raw' || k === 'full' || k === 'recover') { flags[k] = true; continue }
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

function rankOf (db, sessionId, h) {
  return db.prepare("SELECT COUNT(*) n FROM events WHERE session_id = ? AND role != 'title' AND (ts < ? OR (ts = ? AND id < ?))").get(sessionId, h.ts, h.ts, h.id).n
}

function loadSessions (db) {
  const sessions = db.prepare('SELECT id, json FROM sessions').all().map(r => JSON.parse(r.json))
  return { sessionsById: new Map(sessions.map(s => [s.id, s])) }
}

async function main () {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); return }

  const sub = argv[0]
  const isSub = ['ingest', 'index', 'refresh', 'status', 'read', 'raw', 'migrate', 'fingerprint'].includes(sub)
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
    if (flags.recover) {
      const r = recover(paths.root)
      console.log(r.note)
      if (!r.done) process.exit(1)
      return
    }
    const r = await ingest({ root: paths.root, db: flags.db, rebuild: flags.rebuild })
    console.log(`ingest ${r.rebuild ? '(rebuild)' : '(incrémental)'} : +${r.added} events (${r.updated} maj, ${r.unchanged} inchangés), +${r.sessionsAdded} sessions (${r.sessionsUpdated} maj) → ${r.totals.events} events / ${r.totals.sessions} sessions, ${r.rawWritten} raw écrit(s), ${r.shardsTouched} shard(s) touché(s)`)
    return
  }

  if (isSub && sub === 'migrate') {
    const r = await migrate(paths.root)
    console.log(r.note)
    process.exit(r.done ? (r.coherent === false ? 1 : 0) : 1)
  }

  if (isSub && sub === 'fingerprint') {
    const f = fingerprint(paths.root)
    console.log(renderFingerprint(f))
    return
  }

  if (isSub && sub === 'index') {
    if (!fs.existsSync(paths.sessions)) fail('corpus absent — lancer `sdig ingest` d\'abord')
    const r = index(paths.root)
    console.log(`index bm25 : ${r.events} event(s) indexé(s) → ${r.dbFile}`)
    return
  }

  if (isSub && sub === 'refresh') {
    const r1 = await ingest({ root: paths.root, db: flags.db, rebuild: flags.rebuild })
    const r2 = index(paths.root)
    console.log(`refresh : +${r1.added}/${r1.updated} events → corpus ${r1.totals.events}, vue/index ${r2.events}`)
    return
  }

  if (isSub && sub === 'status') {
    let st
    try { st = JSON.parse(fs.readFileSync(paths.state, 'utf8')) } catch { fail('corpus absent — lancer `sdig ingest` d\'abord') }
    let rawFiles = 0
    try { rawFiles = fs.readdirSync(paths.raw, { recursive: true }).filter(f => f.endsWith('.txt')).length } catch {}
    let view = null
    if (viewIsCurrent(paths.root)) {
      const idb = new Database(viewPath(paths.root), { readonly: true })
      try {
        view = { events: idb.prepare("SELECT COUNT(*) n FROM events WHERE role != 'title'").get().n, mtime: fs.statSync(viewPath(paths.root)).mtimeMs }
      } finally { idb.close() }
    }
    const counts = st.counts || { sessions: 0, events: 0 }
    console.log(renderStatus({ counts, rawFiles, layout: st.layoutVersion, watermark: { message: st.message ?? 0, session: st.session ?? 0 }, view }, paths))
    const warn = proofWarning(paths.root)
    if (warn) console.log(warn)
    return
  }

  if (isSub && sub === 'read') {
    const sessionId = positional[0]
    if (!sessionId) fail('usage : sdig read <session> [--around <msgId>] [--ctx N] [--tail N] [--at <ancre>] [--full | --chars N] [--json]')
    const chars = parseChars(flags)
    const { sessionSlice } = await import('../src/read.js')
    const { renderRead, renderReadJson } = await import('../src/format.js')
    let slice
    try {
      slice = sessionSlice(paths.root, sessionId, {
        aroundId: flags.around,
        ctx: flags.ctx ? parseInt(flags.ctx, 10) : 10,
        tail: flags.tail ? parseInt(flags.tail, 10) : undefined,
        at: flags.at
      })
    } catch (e) {
      fail(e.message) // vue absente/périmée : refus explicite, jamais un repli silencieux
    }
    if (!slice) fail(`session inconnue : ${sessionId} (préfixe accepté dans sdig --session, pas ici — id complet requis)`)
    // Ancre invalide : erreur explicite, sortie non nulle, aucune sortie partielle trompeuse.
    if (slice.fatal) fail(slice.error, 2)
    const warn = proofWarning(paths.root)
    if (warn) console.log(warn)
    if (flags.json) { console.log(renderReadJson(slice, sessionId)); return }
    console.log(renderRead(slice, sessionId, { full: !!flags.full, chars, plain: !!flags.plain }))
    return
  }

  if (isSub && sub === 'raw') {
    const partId = positional[0]
    if (!partId) fail('usage : sdig raw <partId> (id de part, cf. rawRef dans les résultats)')
    const file = rawShardPath(paths.raw, partId)
    if (!fs.existsSync(file)) fail(`sortie brute introuvable : ${file}`)
    const warn = proofWarning(paths.root)
    if (warn) console.log(warn)
    // lecture par blocs bornés : l'empreinte mémoire ne dépend pas de la taille du fichier
    const t0 = performance.now()
    let bytes = 0
    streamBlocks(file, { onBlock: (blk) => { bytes += blk.length; process.stdout.write(blk) } })
    if (process.env.SDIG_RAW_TIMING) process.stderr.write(`  (${(performance.now() - t0).toFixed(0)} ms, ${bytes} o)\n`)
    return
  }

  // ── recherche (défaut) ──
  const q = positional.join(' ')
  if (!q) fail('requête manquante\n\n' + USAGE)
  if (!fs.existsSync(viewPath(paths.root))) fail('index absent — lancer `sdig refresh` d\'abord')
  const after = flags.after ? parseDateBound(flags.after, false) : null
  const before = flags.before ? parseDateBound(flags.before, true) : null
  if (flags.after && after == null) fail(`--after : date invalide (${flags.after})`)
  if (flags.before && before == null) fail(`--before : date invalide (${flags.before})`)
  const limit = flags.limit ? parseInt(flags.limit, 10) : 20
  if (!Number.isFinite(limit) || limit < 1) fail('--limit : nombre invalide')

  // UNE Database ouverte pour toute la commande : hits, voisins et compteurs
  // s'exécutent dans le même snapshot (aucune génération intercalée).
  const db = openView(paths.root)
  try {
    const hits = search(db, {
      q, repo: flags.repo, session: flags.session, after, before,
      model: flags.model, role: flags.role, agent: flags.agent,
      limit, plain: flags.plain || flags.json
    })
    if (flags.json) { console.log(renderJson(hits)); return }
    if (!hits.length && !flags.raw) { console.log('aucun résultat'); return }
    const chars = parseChars(flags)
    const prettify = hits.map(h => ({ ...h, role: h.role === 'title' ? 'titre' : h.role }))
    if (hits.length) {
      let ctxBySession = null
      if (flags.ctx) {
        const n = parseInt(flags.ctx, 10)
        if (!Number.isFinite(n) || n < 0) fail('--ctx : nombre invalide')
        // voisins depuis la vue, requêtes bornées, même snapshot que la recherche
        const bySes = new Map()
        for (const h of hits) {
          if (!bySes.has(h.session_id)) bySes.set(h.session_id, [])
          bySes.get(h.session_id).push(h)
        }
        ctxBySession = new Map()
        for (const [sid, hs] of bySes) {
          const idxs = hs.map(h => rankOf(db, sid, h)).filter(i => i >= 0)
          ctxBySession.set(sid, eventsBySessionDb(db, sid, idxs, n).get(sid))
        }
      }
      const { sessionsById } = loadSessions(db)
      console.log(renderTerminal(prettify, sessionsById, { ctx: ctxBySession ? flags.ctx : 0, ctxBySession, plain: flags.plain, full: !!flags.full, chars }))
    }
    if (flags.raw) {
      const { renderRawHits } = await import('../src/format.js')
      const t0 = performance.now()
      const matches = rawScan(paths.root, q, { limit: 10 })
      const dt = performance.now() - t0
      if (matches.length) {
        console.log(renderRawHits(matches))
        if (process.env.SDIG_RAW_TIMING || flags.json) console.error(`  scan raw : ${dt.toFixed(0)} ms`)
      } else if (!hits.length) console.log('aucun résultat (ni index, ni sorties brutes)')
    }
  } finally {
    db.close()
  }
}

main().catch(e => fail(e.message))
