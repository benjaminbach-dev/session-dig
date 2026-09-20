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
import { shardPath, rawShardPath, assertLayout, LAYOUT_VERSION, markerPath, ingestRunning } from './layout.js'
import { viewPath, openViewWrite, buildView, eventCols, viewUsableForIngest, populateView, SCHEMA } from './view.js'

export { markerPath, ingestRunning }

function readState (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

const sesSort = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const evSort = (a, b) => {
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ── Verrou consultatif contre ingestions concurrentes (passe corrective 20/09, revue).
// Création exclusive + reprise sur ESRCH uniquement. L'âge ne prouve pas la mort
// du propriétaire. Ce mécanisme n'est PAS un flock : courses de reprise simultanée,
// verrou illisible et recyclage de PID restent à durcir (voir tasks.md).
export class CorpusLock {
  constructor (lockPath) { this.path = lockPath; this.fd = null }
  acquire () {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.fd = fs.openSync(this.path, 'wx')
        fs.writeSync(this.fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n')
        return true
      } catch {
        // Ne reprendre que si le système confirme la disparition du propriétaire.
        let stale = false
        try {
          const info = JSON.parse(fs.readFileSync(this.path, 'utf8'))
          if (typeof info.pid === 'number' && info.pid > 0 && info.pid !== process.pid) {
            try { process.kill(info.pid, 0) } catch (e) { stale = e.code === 'ESRCH' }
          }
        } catch { /* illisible : refus conservateur */ }
        if (stale) {
          try { fs.rmSync(this.path, { force: true }) } catch {}
          continue // retenter la création
        }
        this.fd = null
        return false
      }
    }
    this.fd = null
    return false
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
// (Définiti dans layout.js, réexporté pour compat.)

/** Avertissement preuves, signalé dans la sortie tant que le marqueur est présent. */
export function proofWarning (root = corpusPaths().root) {
  if (!ingestRunning(root)) return null
  return '⚠ ingestion en cours non réconciliée : une preuve brute peut être plus récente que la vue — relancer `sdig ingest` pour réconcilier, ou `sdig ingest --recover` sans la source (reprise explicite)'
}

/**
 * Reprise explicite sans source : assume l'état sur disque — vue reconstruite
 * depuis le corpus tel qu'il est, watermark de state.json conservé, marqueur
 * retiré. Décision d'opérateur, jamais le défaut d'un rebuild.
 * Passe corrective 20/09 (revue) : prend le VERROU — une reprise concurrente
 * d'une ingestion relancée ne peut plus entrelacer leurs écritures.
 */
export function recover (root = corpusPaths().root) {
  const paths = corpusPaths(root)
  if (!ingestRunning(root)) {
    return { done: false, note: "aucun marqueur d'ingestion en cours — rien à réconcilier" }
  }
  const lock = new CorpusLock(paths.lock)
  if (!lock.acquire()) {
    throw new Error('une opération corpus est déjà en cours (verrou consultatif) — réessayer une fois terminée')
  }
  try {
    const st = readState(paths.state)
    const { events } = buildView(root, { duringRecovery: true })
    atomicWrite(paths.state, JSON.stringify({ ...st, counts: { events, sessions: countSessionsFile(paths.sessions) } }, null, 2) + '\n')
    fs.rmSync(paths.marker, { force: true })
    return {
      done: true,
      note: `reprise explicite : vue reconstruite depuis le corpus tel qu'il est (${events} événements), watermark conservé (message=${st.message}, session=${st.session}) — la prochaine ingestion depuis la source convergera`
    }
  } finally {
    lock.release()
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

  // ── 0. marqueur AVANT tout remplacement ── ; ramassage des temporaires orphelins
  // UNIQUEMENT en réconciliation (passe corrective 20/09, revue : le ramassage
  // inconditionnel parcourait toute l'arborescence du corpus — O(#fichiers) — à
  // CHAQUE passe ; les temporaires n'existent que pendant une passe interrompue,
  // détectée par le marqueur).
  const reconciling = ingestRunning(root)
  if (!reconciling) {
    fs.writeFileSync(paths.marker, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }) + '\n')
  }
  const swept = reconciling ? sweepTemporaries(root) : 0

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

  // Vue : RÉPARABLE pendant la passe (passe corrective 20/09, revue). Une vue
  // absente, de version antérieure ou EN RETARD sur state.json ne repart plus d'une
  // vue VIDE — défaut : les anciens événements restaient dans les shards mais
  // devenaient invisibles dans une vue déclarée fraîche. La base est reconstruite
  // depuis le corpus EN FLUX, puis le delta y est appliqué. Une vue EN AVANCE
  // (crash entre COMMIT et state.json) est un état publié valide : le delta
  // s'y ré-applique idempotemment.
  const usable = !rebuild && viewUsableForIngest(root)
  const viewFile = usable ? viewPath(root) : `${viewPath(root)}.new`

  let maxMsgUp = -1
  let maxSesUp = -1
  let rawWritten = 0
  let shardsTouched = 0
  const counts = { added: 0, updated: 0, unchanged: 0, sessionsAdded: 0, sessionsUpdated: 0 }
  const sesTouched = new Map() // id → session finale (modifiées seulement)

  // ── staging des shards AU FIL DU FLUX (passe corrective 20/09) : les événements
  // arrivent groupés par session (adaptateur ORDER BY session_id) — chaque session
  // est écrite dès qu'elle est complète, fusionnée EN FLUX avec son shard publié.
  // Mémoire : les événements d'UNE session (prix documenté du layout), jamais
  // l'accumulation du delta entier — l'ancienne version gardait tout en RAM
  // jusqu'à la fin : à la première ingestion, le delta EST le corpus entier.
  const renamesBySession = new Map() // sessionId → { from, to }
  let cur = null // { sessionId, evs: Map(id → event) } — session en cours de réception

  const writeSessionShard = (sessionId, newEvents) => {
    const file = shardPath(root, sessionId)
    ensureDir(path.dirname(file))
    const tmp = `${file}.new-${process.pid}`
    // Base de fusion : le .new déjà stagé (re-saisie défensive d'un flux désordonné)
    // sinon le shard publié. Si la base est le tmp lui-même, préchargement au
    // préalable (borné par la session) : on ne peut pas lire et tronquer le même
    // fichier en même temps.
    let preload = null
    let base = null
    if (fs.existsSync(tmp)) {
      base = tmp
      preload = []
      streamLines(tmp, (l) => { try { preload.push(JSON.parse(l)) } catch { /* garde-fou */ } })
    } else if (!rebuild && fs.existsSync(file)) {
      base = file
    }
    const news = [...newEvents.values()].sort(evSort)
    const fd = fs.openSync(tmp, 'w')
    let buf = []
    let buflen = 0
    const write = (obj) => {
      const line = JSON.stringify(obj)
      buf.push(line)
      buflen += line.length + 1
      if (buflen >= (1 << 20)) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; buflen = 0 }
    }
    try {
      let ni = 0
      const mergeOld = (old) => {
        let skipOld = false
        while (ni < news.length) {
          const c = evSort(news[ni], old)
          if (c < 0) { write(news[ni]); ni++ }
          else if (c === 0) { write(news[ni]); ni++; skipOld = true; break } // même id : la nouvelle version remplace
          else break
        }
        if (!skipOld) write(old)
      }
      if (preload) for (const old of preload) mergeOld(old)
      else if (base) streamLines(base, (line) => { let old; try { old = JSON.parse(line) } catch { return }; mergeOld(old) })
      while (ni < news.length) { write(news[ni]); ni++ }
      if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n')
    } finally {
      fs.closeSync(fd)
    }
    renamesBySession.set(sessionId, { from: tmp, to: file })
    shardsTouched++
  }
  const finalizeCurrent = () => {
    if (!cur) return
    writeSessionShard(cur.sessionId, cur.evs)
    cur = null
  }

  const vdb = openViewWrite(root, viewFile)
  try {
    if (vdb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='events'").get().n === 0) {
      vdb.exec(SCHEMA)
    }
    if (!usable) {
      // base reconstruite depuis le corpus, EN FLUX, AVANT d'y appliquer le delta
      if (!rebuild) populateView(vdb, root)
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
        if (usable) delFts.run(old.rid, old.text ?? '', old.cmd ?? '')
        delEv.run(s.id)
      }
      if (s.title && !sameTitle) {
        const tj = { schemaVersion: 1, id: s.id, sessionId: s.id, ts: s.tsCreated ?? s.tsUpdated ?? 0, role: 'title', text: s.title, repo: s.repo ?? null }
        const info = insEv.run(s.id, s.id, tj.ts, 'title', null, s.repo ?? null, null, null, s.title, JSON.stringify(tj))
        if (usable) insFts.run(info.lastInsertRowid, s.title, null)
      }
    }

    const upsertEvent = (e) => {
      const jsonLine = JSON.stringify(e)
      const old = selEv.get(e.id)
      if (old) {
        if (old.json === jsonLine) { counts.unchanged++; return } // idempotence : rien à faire
        if (usable) delFts.run(old.rid, old.text ?? '', old.cmd ?? '')
        delEv.run(e.id)
        counts.updated++
      } else {
        counts.added++
      }
      const { cmds, model } = eventCols(e)
      const info = insEv.run(e.id, e.sessionId, e.ts, e.role ?? null, e.agent ?? null, e.repo ?? null, model, cmds, e.text ?? '', jsonLine)
      if (usable) insFts.run(info.lastInsertRowid, e.text ?? '', cmds)
      for (const c of e.toolCalls || []) {
        if (c.rawRef) insRef.run(String(c.rawRef), e.id, e.sessionId, e.ts, e.role ?? null, c.tool ?? null, c.cmd ?? null)
      }
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
      // comparaison par empreinte (passe corrective 20/09) : l'ancien readFileSync
      // de tout le fichier doublait la mémoire transitoire sur les preuves volumineuses
      let same = false
      try {
        same = md5File(file) === crypto.createHash('md5').update(r.content, 'utf8').digest('hex')
      } catch { same = false }
      if (!same) {
        const tmp = `${file}.new-${process.pid}`
        fs.writeFileSync(tmp, r.content)
        fs.renameSync(tmp, file) // chaque shard raw publié atomiquement
        rawWritten++
      }
    }

    // ── 1. delta lu dans la source, par lots bornés (watermark en requête) ──
    // Les événements arrivent GROUPÉS PAR SESSION (ORDER BY session_id) : chaque
    // session est finalisée (shard fusionné + écrit) dès que le flux passe à la
    // suivante — jamais d'accumulation du delta entier en mémoire.
    await adaptPaged(dbPath, since, {
      batchSize: Number(process.env.SDIG_INGEST_BATCH || 2000)
    }, (batch) => {
      for (const s of batch.sessions) {
        upsertSession(s)
        if (s.tsUpdated > maxSesUp) maxSesUp = s.tsUpdated
      }
      for (const e of batch.events) {
        if (!cur || cur.sessionId !== e.sessionId) {
          finalizeCurrent()
          cur = { sessionId: e.sessionId, evs: new Map() }
        }
        cur.evs.set(e.id, e)
        upsertEvent(e)
        if (e.ts > maxMsgUp) maxMsgUp = e.ts
      }
      for (const r of batch.rawOutputs) writeRaw(r)
      if (batch.maxMessageUpdate > maxMsgUp) maxMsgUp = batch.maxMessageUpdate
      if (batch.maxSessionUpdate > maxSesUp) maxSesUp = batch.maxSessionUpdate
    })
    finalizeCurrent()
  } catch (e) {
    // Échec avant publication : rollback de la vue ; le marqueur reste posé —
    // la passe suivante réconcilie. Aucun shard partiel publié (renames non faits).
    try { vdb.exec('ROLLBACK') } catch {}
    vdb.close()
    if (!usable) { try { fs.rmSync(`${viewPath(root)}.new`, { force: true }) } catch {} }
    throw e
  }

  // ── 2. fin du flux : shards déjà écrits au fil de l'eau ; métadonnées en flux ──
  const renames = [...renamesBySession.values()]

  // Métadonnées de sessions : fusion EN FLUX (passe corrective 20/09, revue :
  // l'ancienne version matérialisait TOUTES les sessions en RAM avant réécriture —
  // le coût O(#sessions), explicitement permis par la spec, est celui du PARCOURS
  // fusionné, pas de l'accumulation). Ordre stable par id, octet par octet.
  if (sesTouched.size > 0) {
    const touched = [...sesTouched.values()].sort(sesSort)
    const tmp = `${paths.sessions}.new-${process.pid}`
    const fd = fs.openSync(tmp, 'w')
    let buf = []
    const push = (s) => {
      buf.push(JSON.stringify(s))
      if (buf.length >= 1000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = [] }
    }
    let ti = 0
    if (!rebuild && fs.existsSync(paths.sessions)) {
      streamLines(paths.sessions, (line) => {
        let s
        try { s = JSON.parse(line) } catch { return } // ligne illégale : ignorée (jamais produite par l'outil)
        while (ti < touched.length && sesSort(touched[ti], s) < 0) { push(touched[ti]); ti++ }
        if (ti < touched.length && touched[ti].id === s.id) { push(touched[ti]); ti++ } // remplace
        else push(s)
      })
    }
    while (ti < touched.length) { push(touched[ti]); ti++ }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n')
    fs.closeSync(fd)
    renames.push({ from: tmp, to: paths.sessions })
  }

  // ── 3. publication : renames → COMMIT de la vue (POINT DE PUBLICATION) →
  //       state.json → retrait du marqueur ──
  for (const r of renames) {
    ensureDir(path.dirname(r.to))
    fs.renameSync(r.from, r.to)
  }
  // vue réparée pendant la passe (base reconstruite + delta) : FTS reconstruit
  // en une fois depuis le contenu — les insertions delta sont couvertes par le rebuild
  if (!usable) vdb.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`)
  vdb.prepare('DELETE FROM watermark').run()
  vdb.prepare('INSERT INTO watermark (message, session) VALUES (?,?)').run(
    Math.max(since.message, maxMsgUp),
    Math.max(since.session, maxSesUp)
  )
  vdb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('layoutVersion', String(LAYOUT_VERSION))
  vdb.exec('COMMIT') // ← point de publication
  vdb.pragma('wal_checkpoint(TRUNCATE)')
  vdb.close()
  if (!usable) fs.renameSync(`${viewPath(root)}.new`, viewPath(root))

  // Totaux ARITHMÉTIQUES (passe corrective 20/09, revue : recompter tous les
  // événements/sessions à chaque passe coûtait O(corpus) — la formule de coût de
  // la spec est delta + sessions touchées + métadonnées, rien d'autre). Repli au
  // dénombrement complet en reconstruction/réconciliation ou sans comptes fiables.
  // Après COMMIT avant state.json, les inserts rejoués sont déjà présents :
  // anciens comptes + counts.added sous-compterait le nouvel état publié.
  const prevCounts = (!rebuild && usable && !reconciling && prev.counts && Number.isFinite(prev.counts.events) && Number.isFinite(prev.counts.sessions)) ? prev.counts : null
  const totals = prevCounts
    ? { sessions: prevCounts.sessions + counts.sessionsAdded, events: prevCounts.events + counts.added }
    : { sessions: countSessionsFile(paths.sessions), events: countEventsView(root) }
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
    shardsTouched,
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
    // duringRecovery : migrate est une commande opérateur tenant le verrou, son propre
    // marqueur est posé volontairement — le garde-fou buildView ne s'y applique pas.
    buildView(root, { duringRecovery: true })
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
