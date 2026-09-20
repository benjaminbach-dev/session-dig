// Corpus (change scale-corpus) : ingestion incrémentale O(delta) vers le layout v2
// (shards par session, préfixe par condensat), protocole de publication avec marqueur
// persistant d'ingestion en cours, vue dérivable maintenue dans la transaction de
// publication, migration v1→v2 en flux, empreinte déterministe.
//
// Les enregistrements (schéma d'un événement, d'une session) sont strictement
// inchangés depuis la v1 — seule la découpe des fichiers change, portée par
// layoutVersion dans state.json.
//
// Coût d'une passe incrémentale (formule honnête, design D3) : delta lu dans la
// source + volume des sessions touchées + réécriture des métadonnées de sessions —
// et rien d'autre : jamais le volume du reste du corpus, jamais un parcours complet
// de la source hors le filtre watermark exécuté par la base. Ajouter un message à
// une session géante réécrit le shard de cette session : prix du layout, documenté.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { adaptPaged } from './adapter/opencode-page.js'
import { atomicWrite, streamLines, ensureDir, md5File } from './util.js'
import { corpusPaths, sourceDb } from './paths.js'
import { shardPath, rawShardPath, assertLayout, LAYOUT_VERSION } from './layout.js'
import { viewPath, openViewWrite, buildView, eventCols, viewIsCurrent, SCHEMA } from './view.js'

function readState (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

const sesSort = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const evSort = (a, b) => {
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ── Verrou consultatif : création exclusive (flag 'wx', atomique) du fichier de
// verrou. La seconde ingestion échoue proprement ; les lecteurs ne verrouillent pas.
export class CorpusLock {
  constructor (lockPath) { this.path = lockPath; this.fd = null }
  acquire () {
    try {
      this.fd = fs.openSync(this.path, 'wx')
      fs.writeSync(this.fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n')
      return true
    } catch {
      this.fd = null
      return false
    }
  }
  release () {
    if (this.fd != null) {
      try { fs.closeSync(this.fd) } catch {}
      try { fs.rmSync(this.path, { force: true }) } catch {}
      this.fd = null
    }
  }
}

// ── Marqueur persistant d'ingestion en cours : posé AVANT tout remplacement de
// fichier, retiré en tout dernier (après state.json). Un crash après le dernier
// rename, avant le COMMIT, ne laisse plus de `.new` ni d'écart de state.json —
// le marqueur est le seul détecteur fiable de cet état.
export function markerPath (root = corpusPaths().root) { return corpusPaths(root).marker }
export function ingestRunning (root = corpusPaths().root) { return fs.existsSync(markerPath(root)) }

/** Avertissement preuves, signalé dans la sortie tant que le marqueur est présent. */
export function proofWarning (root = corpusPaths().root) {
  if (!ingestRunning(root)) return null
  return '⚠ ingestion en cours non réconciliée : une preuve brute peut être plus récente que la vue — relancer `sdig ingest` pour réconcilier, ou `sdig ingest --recover` sans la source (reprise explicite)'
}

/**
 * Reprise explicite sans source : assume l'état sur disque — vue reconstruite
 * depuis le corpus tel qu'il est, watermark de state.json conservé, marqueur
 * retiré. Décision d'opérateur, jamais le défaut d'un rebuild.
 */
export function recover (root = corpusPaths().root) {
  const paths = corpusPaths(root)
  if (!ingestRunning(root)) {
    return { done: false, note: "aucun marqueur d'ingestion en cours — rien à réconcilier" }
  }
  const st = readState(paths.state)
  const { events } = buildView(root)
  fs.rmSync(paths.marker, { force: true })
  return {
    done: true,
    note: `reprise explicite : vue reconstruite depuis le corpus tel qu'il est (${events} événements), watermark conservé (message=${st.message}, session=${st.session}) — la prochaine ingestion depuis la source convergera`
  }
}

/** Ramassage des temporaires orphelins (crash avant publication) à la passe suivante. */
function sweepTemporaries (root) {
  const paths = corpusPaths(root)
  let n = 0
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.includes('.new-') || e.name.endsWith('.new')) { fs.rmSync(p, { force: true }); n++ }
    }
  }
  walk(paths.root)
  return n
}

function countSessionsFile (sessionsFile) {
  let n = 0
  streamLines(sessionsFile, () => { n++ })
  return n
}

/**
 * Ingestion : source → corpus v2. Incrémentale par défaut (watermark en requête
 * sur time_updated — le filtre est exécuté par la base, jamais filtré après coup).
 * `--rebuild` : purge corpus + raw + vue, réingestion intégrale (réparation).
 *
 * Protocole de publication : marqueur → staging (.new) → renames → COMMIT de la
 * vue (POINT DE PUBLICATION) → state.json → retrait du marqueur. Chaque shard est
 * publié atomiquement (rename) — jamais de shard déchiré ; entre shards, la
 * publication est éventuelle, mais aucune lecture ne consulte les shards : elle
 * passe par la vue, dont la transaction est atomique.
 */
export async function ingest (opts = {}) {
  const root = opts.root ?? corpusPaths().root
  const dbPath = sourceDb(opts.db)
  const paths = corpusPaths(root)
  ensureDir(root)
  ensureDir(paths.raw)

  const lock = new CorpusLock(paths.lock)
  if (!lock.acquire()) {
    throw new Error('une ingestion est déjà en cours sur ce corpus (verrou consultatif) — réessayer une fois la première terminée')
  }
  try {
    return await _ingest(root, paths, dbPath, opts)
  } finally {
    lock.release()
  }
}

async function _ingest (root, paths, dbPath, opts) {
  const rebuild = !!opts.rebuild
  const prev = rebuild ? {} : readState(paths.state)
  // Un corpus v1 passe par la migration : refus explicite avec la marche à suivre.
  if (!rebuild && prev.layoutVersion != null) assertLayout(prev)
  if (!rebuild && prev.layoutVersion == null && fs.existsSync(paths.events) && !fs.existsSync(paths.eventsDir)) {
    throw new Error('corpus v1 détecté (events.jsonl sans events/) — lancer `sdig migrate` (sans la source) ou `sdig ingest --rebuild` (depuis la source)')
  }

  // ── 0. marqueur AVANT tout remplacement + ramassage des temporaires orphelins ──
  if (!ingestRunning(root)) {
    fs.writeFileSync(paths.marker, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }) + '\n')
  }
  const swept = sweepTemporaries(root)

  if (rebuild) {
    // Rebuild = repartir de zéro : corpus, raw et vue purgés puis régénérés.
    fs.rmSync(paths.eventsDir, { recursive: true, force: true })
    fs.rmSync(paths.raw, { recursive: true, force: true })
    fs.rmSync(paths.sessions, { force: true })
    ensureDir(paths.raw)
  }
  const since = {
    message: rebuild ? -1 : (typeof prev.message === 'number' ? prev.message : -1),
    session: rebuild ? -1 : (typeof prev.session === 'number' ? prev.session : -1)
  }

  // Vue : si absente ou d'une version antérieure (index v0), on construit une vue
  // neuve sous .new et on la publie au COMMIT ; sinon on met à jour l'existant
  // dans une transaction unique (le COMMIT est le point de publication).
  const current = !rebuild && viewIsCurrent(root)
  const viewFile = current ? viewPath(root) : `${viewPath(root)}.new`

  let maxMsgUp = -1
  let maxSesUp = -1
  let rawWritten = 0
  const counts = { added: 0, updated: 0, unchanged: 0, sessionsAdded: 0, sessionsUpdated: 0 }
  const stagedShards = new Map() // sessionId → Map(id → event) — sessions touchées seulement
  const sesTouched = new Map() // id → session finale (modifiées seulement)

  const vdb = openViewWrite(root, viewFile)
  try {
    if (vdb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='events'").get().n === 0) {
      vdb.exec(SCHEMA)
    }
    vdb.exec('BEGIN')

    const selEv = vdb.prepare('SELECT rowid AS rid, json, text, cmd FROM events WHERE id = ?')
    const delEv = vdb.prepare('DELETE FROM events WHERE id = ?')
    const delFts = vdb.prepare("INSERT INTO events_fts(events_fts, rowid, text, cmd) VALUES ('delete', ?, ?, ?)")
    const insEv = vdb.prepare('INSERT INTO events (id, session_id, ts, role, agent, repo, model, cmd, text, json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    const insFts = vdb.prepare('INSERT INTO events_fts(rowid, text, cmd) VALUES (?,?,?)')
    const selSes = vdb.prepare('SELECT json FROM sessions WHERE id = ?')
    const delSes = vdb.prepare('DELETE FROM sessions WHERE id = ?')
    const insSes = vdb.prepare('INSERT INTO sessions (id, json, title, repo, tsCreated, tsUpdated, directory, cost, parentSession) VALUES (?,?,?,?,?,?,?,?,?)')
    const insRef = vdb.prepare('INSERT OR REPLACE INTO rawrefs (rawRef, eventId, sessionId, ts, role, tool, cmd) VALUES (?,?,?,?,?,?,?)')

    // Ligne de titre synthétique d'une session (décision 17/09) : id = id de session,
    // role 'title'. Retirée/réécrite quand le titre change ou disparaît.
    const upsertTitleRow = (s) => {
      const old = selEv.get(s.id)
      const sameTitle = old && old.text === (s.title ?? null)
      if (old && !sameTitle) {
        delFts.run(old.rid, old.text ?? '', old.cmd ?? '')
        delEv.run(s.id)
      }
      if (s.title && !sameTitle) {
        const tj = { schemaVersion: 1, id: s.id, sessionId: s.id, ts: s.tsCreated ?? s.tsUpdated ?? 0, role: 'title', text: s.title, repo: s.repo ?? null }
        const info = insEv.run(s.id, s.id, tj.ts, 'title', null, s.repo ?? null, null, null, s.title, JSON.stringify(tj))
        insFts.run(info.lastInsertRowid, s.title, null)
      }
    }

    const upsertEvent = (e) => {
      const jsonLine = JSON.stringify(e)
      const old = selEv.get(e.id)
      if (old) {
        if (old.json === jsonLine) { counts.unchanged++; return } // idempotence : rien à faire
        delFts.run(old.rid, old.text ?? '', old.cmd ?? '')
        delEv.run(e.id)
        counts.updated++
      } else {
        counts.added++
      }
      const { cmds, model } = eventCols(e)
      const info = insEv.run(e.id, e.sessionId, e.ts, e.role ?? null, e.agent ?? null, e.repo ?? null, model, cmds, e.text ?? '', jsonLine)
      insFts.run(info.lastInsertRowid, e.text ?? '', cmds)
      for (const c of e.toolCalls || []) {
        if (c.rawRef) insRef.run(String(c.rawRef), e.id, e.sessionId, e.ts, e.role ?? null, c.tool ?? null, c.cmd ?? null)
      }
      if (!stagedShards.has(e.sessionId)) stagedShards.set(e.sessionId, new Map())
      stagedShards.get(e.sessionId).set(e.id, e)
    }

    const upsertSession = (s) => {
      const jsonLine = JSON.stringify(s)
      const old = selSes.get(s.id)
      if (old) {
        if (old.json === jsonLine) return // idempotence : session inchangée
        delSes.run(s.id)
        counts.sessionsUpdated++
      } else {
        counts.sessionsAdded++
      }
      insSes.run(s.id, jsonLine, s.title ?? null, s.repo ?? null, s.tsCreated ?? null, s.tsUpdated ?? null, s.directory ?? null, s.cost ?? null, s.parentSession ?? null)
      upsertTitleRow(s)
      sesTouched.set(s.id, s)
    }

    const writeRaw = (r) => {
      const file = rawShardPath(paths.raw, String(r.id))
      ensureDir(path.dirname(file))
      let same = false
      try { same = fs.readFileSync(file, 'utf8') === r.content } catch { same = false }
      if (!same) {
        const tmp = `${file}.new-${process.pid}`
        fs.writeFileSync(tmp, r.content)
        fs.renameSync(tmp, file) // chaque shard raw publié atomiquement
        rawWritten++
      }
    }

    // ── 1. delta lu dans la source, par lots bornés (watermark en requête) ──
    await adaptPaged(dbPath, since, {
      batchSize: Number(process.env.SDIG_INGEST_BATCH || 2000)
    }, (batch) => {
      for (const s of batch.sessions) {
        upsertSession(s)
        if (s.tsUpdated > maxSesUp) maxSesUp = s.tsUpdated
      }
      for (const e of batch.events) {
        upsertEvent(e)
        if (e.ts > maxMsgUp) maxMsgUp = e.ts
      }
      for (const r of batch.rawOutputs) writeRaw(r)
      if (batch.maxMessageUpdate > maxMsgUp) maxMsgUp = batch.maxMessageUpdate
      if (batch.maxSessionUpdate > maxSesUp) maxSesUp = batch.maxSessionUpdate
    })
  } catch (e) {
    // Échec avant publication : rollback de la vue ; le marqueur reste posé —
    // la passe suivante réconcilie. Aucun shard partiel publié (renames non faits).
    try { vdb.exec('ROLLBACK') } catch {}
    vdb.close()
    if (!current) { try { fs.rmSync(`${viewPath(root)}.new`, { force: true }) } catch {} }
    throw e
  }

  // ── 2. staging : shards des sessions touchées, fusion ordonnée (ts,id), .new ──
  const renames = []
  for (const [sessionId, newById] of stagedShards) {
    const file = shardPath(root, sessionId)
    ensureDir(path.dirname(file))
    const byId = new Map()
    if (!rebuild && fs.existsSync(file)) {
      streamLines(file, (line) => {
        try { const e = JSON.parse(line); byId.set(e.id, e) } catch { /* shard jamais déchiré ; garde-fou */ }
      })
    }
    for (const e of newById.values()) byId.set(e.id, e)
    const merged = [...byId.values()].sort(evSort)
    const tmp = `${file}.new-${process.pid}`
    fs.writeFileSync(tmp, merged.map(e => JSON.stringify(e)).join('\n') + '\n')
    renames.push({ from: tmp, to: file })
  }

  // Métadonnées de sessions : réécriture complète en flux — le seul coût O(#sessions)
  // d'une passe, borné et documenté (ordre stable par id, octet par octet).
  if (sesTouched.size > 0) {
    const out = []
    const pending = new Set(sesTouched.keys())
    if (!rebuild && fs.existsSync(paths.sessions)) {
      streamLines(paths.sessions, (line) => {
        try {
          const s = JSON.parse(line)
          if (sesTouched.has(s.id)) { out.push(sesTouched.get(s.id)); pending.delete(s.id) } else { out.push(s) }
        } catch { /* ligne illégale : ignorée (jamais produite par l'outil) */ }
      })
    }
    for (const id of [...pending].sort(sesSort)) out.push(sesTouched.get(id))
    out.sort(sesSort)
    const tmp = `${paths.sessions}.new-${process.pid}`
    fs.writeFileSync(tmp, out.map(s => JSON.stringify(s)).join('\n') + '\n')
    renames.push({ from: tmp, to: paths.sessions })
  }

  // ── 3. publication : renames → COMMIT de la vue (POINT DE PUBLICATION) →
  //       state.json → retrait du marqueur ──
  for (const r of renames) {
    ensureDir(path.dirname(r.to))
    fs.renameSync(r.from, r.to)
  }
  vdb.prepare('DELETE FROM watermark').run()
  vdb.prepare('INSERT INTO watermark (message, session) VALUES (?,?)').run(
    Math.max(since.message, maxMsgUp),
    Math.max(since.session, maxSesUp)
  )
  vdb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('layoutVersion', String(LAYOUT_VERSION))
  vdb.exec('COMMIT') // ← point de publication
  vdb.pragma('wal_checkpoint(TRUNCATE)')
  vdb.close()
  if (!current) fs.renameSync(`${viewPath(root)}.new`, viewPath(root))

  const totals = { sessions: countSessionsFile(paths.sessions), events: countEventsView(root) }
  const state = {
    source: dbPath,
    message: Math.max(since.message, maxMsgUp),
    session: Math.max(since.session, maxSesUp),
    updatedAt: Date.now(),
    layoutVersion: LAYOUT_VERSION,
    counts: totals
  }
  atomicWrite(paths.state, JSON.stringify(state, null, 2) + '\n')
  fs.rmSync(paths.marker, { force: true }) // retiré en tout dernier

  return {
    added: counts.added, updated: counts.updated, unchanged: counts.unchanged,
    sessionsAdded: counts.sessionsAdded, sessionsUpdated: counts.sessionsUpdated,
    totals,
    rawWritten,
    swept,
    shardsTouched: stagedShards.size,
    watermark: { message: state.message, session: state.session },
    rebuild
  }
}

function countEventsView (root) {
  try {
    const db = new Database(viewPath(root), { readonly: true, fileMustExist: true })
    try { return db.prepare("SELECT COUNT(*) n FROM events WHERE role != 'title'").get().n } finally { db.close() }
  } catch { return 0 }
}

/** Déplace les preuves brutes encore flat (v1) vers raw/<p>/<partId>.txt. */
function shardFlatRaws (paths) {
  let n = 0
  let entries
  try { entries = fs.readdirSync(paths.raw, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.txt')) continue
    const from = path.join(paths.raw, e.name)
    const to = rawShardPath(paths.raw, e.name.slice(0, -4))
    ensureDir(path.dirname(to))
    fs.renameSync(from, to)
    n++
  }
  return n
}

/**
 * Migration v1 → v2 SANS la source : en flux ligne à ligne (jamais le corpus v1
 * entier en RAM — le corpus est trié (sessionId, ts, id), une seule session à la
 * fois réside en mémoire), idempotente, vérifiée (comptes annoncés, incohérences
 * signalées). Les opérations d'archive refusent tant que le marqueur est présent.
 */
export async function migrate (root = corpusPaths().root) {
  const paths = corpusPaths(root)
  const state = readState(paths.state)
  if (state.layoutVersion === LAYOUT_VERSION) {
    // déjà v2 : la reprise shardé les preuves brutes restées flat (idempotent —
    // relancer ne modifie rien de plus), puis rien à faire.
    const n = shardFlatRaws(paths)
    return {
      done: false,
      note: `corpus déjà en layout v${LAYOUT_VERSION} — rien à faire${n ? ` (${n} preuve(s) brute(s) encore flat, shardée(s) maintenant)` : ''}`
    }
  }
  if (!fs.existsSync(paths.events)) throw new Error('corpus v1 introuvable (events.jsonl absent) — rien à migrer')
  if (ingestRunning(root)) {
    throw new Error("ingestion en cours (marqueur présent) — réconcilier d'abord : relancer `sdig ingest` ou `sdig ingest --recover`")
  }

  const lock = new CorpusLock(paths.lock)
  if (!lock.acquire()) throw new Error('une opération corpus est déjà en cours — réessayer plus tard')
  try {
    fs.writeFileSync(paths.marker, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, op: 'migrate' }) + '\n')

    // comptes d'origine (vérification annoncée à l'issue)
    let origEvents = 0; let origSessions = 0
    streamLines(paths.events, () => { origEvents++ })
    streamLines(paths.sessions, () => { origSessions++ })

    // découpe en shards, en flux : le corpus v1 est trié (sessionId, ts, id) —
    // une seule session à la fois en mémoire.
    const badLines = []
    const seenSessions = new Set()
    let evCount = 0
    let cur = { id: null, evs: [] }
    const flush = () => {
      if (cur.id == null) return
      cur.evs.sort(evSort)
      const file = shardPath(root, cur.id)
      ensureDir(path.dirname(file))
      const tmp = `${file}.new-${process.pid}`
      fs.writeFileSync(tmp, cur.evs.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.renameSync(tmp, file)
      seenSessions.add(cur.id)
      cur = { id: null, evs: [] }
    }
    streamLines(paths.events, (line) => {
      let e
      try { e = JSON.parse(line) } catch { badLines.push(evCount); evCount++; return }
      if (e.sessionId !== cur.id) { flush(); cur = { id: e.sessionId, evs: [] } }
      cur.evs.push(e)
      evCount++
    })
    flush()

    // sessions sans événement : signalées, jamais ignorées
    const emptySessions = new Set()
    streamLines(paths.sessions, (line) => {
      try { const s = JSON.parse(line); if (!seenSessions.has(s.id)) emptySessions.add(s.id) } catch {}
    })

    // preuves brutes : flat v1 → shards raw/<p>/<partId>.txt (même principe que events)
    const rawMoved = shardFlatRaws(paths)

    // vue reconstruite depuis le corpus v2 fraîchement écrit (watermark de state conservé)
    buildView(root)
    const newState = {
      ...state,
      layoutVersion: LAYOUT_VERSION,
      updatedAt: Date.now(),
      counts: { sessions: countSessionsFile(paths.sessions), events: evCount }
    }
    atomicWrite(paths.state, JSON.stringify(newState, null, 2) + '\n')
    fs.rmSync(paths.marker, { force: true })

    const coherent = evCount === origEvents && newState.counts.sessions === origSessions
    return {
      done: true,
      events: evCount,
      sessions: newState.counts.sessions,
      expected: { events: origEvents, sessions: origSessions },
      badLines,
      emptySessions: [...emptySessions],
      coherent,
      note: `migration v1→v2 : ${evCount}/${origEvents} événements, ${newState.counts.sessions}/${origSessions} sessions` +
        (coherent ? '' : ' — ⚠ écart de comptes, investiguer avant usage') +
        (badLines.length ? ` — ${badLines.length} ligne(s) illisible(s) (positions ${badLines.slice(0, 5).join(', ')}${badLines.length > 5 ? '…' : ''})` : '') +
        (emptySessions.size ? ` — ${emptySessions.size} session(s) sans événement : ${[...emptySessions].slice(0, 3).join(', ')}${emptySessions.size > 3 ? '…' : ''}` : '') +
        ` — ${rawMoved} preuve(s) shardée(s)` +
        ' — events.jsonl (v1) conservé sur disque ; supprimable manuellement après vérification'
    }
  } finally {
    lock.release()
  }
}

/**
 * Empreinte déterministe du corpus : md5 par fichier (lu par blocs bornés),
 * agrégé sur les chemins relatifs triés — indépendant de l'ordre de parcours du
 * système de fichiers. O(taille du corpus) : commande explicite, jamais exécutée
 * sur le chemin des lectures. Outil des conditions d'évaluation ET de détection
 * des modifications hors ingestion (ce que le watermark ne peut pas voir).
 * Fichiers dérivés (index.db et WAL, verrou) exclus : jetables, non corpus.
 * Refuse tant que le marqueur d'ingestion en cours est présent (état non réconcilié).
 */
export function fingerprint (root = corpusPaths().root) {
  if (ingestRunning(root)) {
    throw new Error("ingestion en cours non réconciliée (marqueur présent) — l'empreinte ne peut pas faire foi sur un état non publié : relancer `sdig ingest` ou `sdig ingest --recover`")
  }
  const paths = corpusPaths(root)
  const DERIVED = /^(index\.db|\.ingest-lock)(-wal|-shm)?$/
  const files = []
  const walk = (dir, rel = '') => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else if (!DERIVED.test(r) && !r.includes('.tmp-') && !r.includes('.new-')) files.push([r, path.join(dir, e.name)])
    }
  }
  walk(paths.root)
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const agg = crypto.createHash('md5')
  const perFile = []
  let bytes = 0
  for (const [rel, abs] of files) {
    const d = md5File(abs)
    bytes += fs.statSync(abs).size
    perFile.push({ file: rel, md5: d })
    agg.update(rel); agg.update('\0'); agg.update(d); agg.update('\0')
  }
  return { fingerprint: agg.digest('hex'), files: perFile, bytes }
}

/**
 * TESTS UNIQUEMENT — charge la session entière depuis la vue. Interdit sur les
 * chemins de commande (change scale-corpus, D4 : aucune commande ne charge le
 * corpus en entier) ; conservé pour les fixtures de test à échelle minuscule.
 */
export function loadCorpus (root = corpusPaths().root) {
  const db = new Database(viewPath(root), { readonly: true, fileMustExist: true })
  try {
    const events = db.prepare("SELECT json FROM events WHERE role != 'title' ORDER BY session_id, ts, id").all().map(r => JSON.parse(r.json))
    const sessions = db.prepare('SELECT json FROM sessions ORDER BY id').all().map(r => JSON.parse(r.json))
    return { events, sessions, sessionsById: new Map(sessions.map(s => [s.id, s])) }
  } finally {
    db.close()
  }
}
