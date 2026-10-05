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
import { adaptPi } from './adapter/pi.js'
import { atomicWrite, streamLines, ensureDir, md5File } from './util.js'
import { corpusPaths, sourceDb, sourcePi } from './paths.js'
import { shardPath, rawShardPath, assertLayout, LAYOUT_VERSION, markerPath, ingestRunning } from './layout.js'
import { viewPath, openViewWrite, buildView, eventCols, viewUsableForIngest, populateView, SCHEMA, sourceStatesOf, ocTokenOf, piTokenOf, newGeneration, GENERATION_KEY } from './view.js'
import { CorpusLock } from './lock.js'

export { markerPath, ingestRunning }
// CorpusLock extrait dans src/lock.js (lot A2, sans cycle) — réexporté pour compat
// avec les importations existantes (tests, helpers enfant du verrou).
export { CorpusLock }

function readState (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

const sesSort = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const evSort = (a, b) => {
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ── CorpusLock vit désormais dans src/lock.js (lot A2) : module partagé sans cycle,
// importé aussi par view.js (buildView). Réexporté ci-dessus pour compat.

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
  // Lot A2 : le verrou est acquis AVANT tout contrôle, parcours et mutation — le
  // test du marqueur (y compris son no-op sans marqueur) a lieu SOUS verrou, libéré
  // en finally sur succès, no-op et erreur. recover reste le SEUL parcours
  // explicitement autorisé sous son marqueur.
  const lock = new CorpusLock(paths.lock)
  if (!lock.acquire()) {
    throw new Error(`une opération corpus est déjà en cours (verrou consultatif ${paths.lock}) — réessayer une fois terminée. Si son propriétaire est confirmé mort, retirer le fichier de verrou (et ses annexes -journal/-wal/-shm) manuellement UNIQUEMENT après arrêt coordonné de tous les utilisateurs du corpus, jamais sous concurrence`)
  }
  try {
    if (!ingestRunning(root)) {
      return { done: false, note: "aucun marqueur d'ingestion en cours — rien à réconcilier" }
    }
    const st = readState(paths.state)
    // Ramassage des temporaires orphelins AVANT tout et AVANT le retrait du marqueur
    // (même primitive qu'en réconciliation) : sans lui, un opérateur qui passe par
    // `recover` seul laissait les `.new-<pid>` d'un crash derrière lui — la passe
    // suivante ne les voyait plus (reconciling=false). Ne touche QUE les noms
    // temporaires du protocole : jamais un shard publié ni un id qui contiendrait
    // `.tmp-`/`.new-`.
    const swept = sweepTemporaries(root)
    // Verrou DÉJÀ DÉTENU transmis à buildView (instance validée, jamais un booléen) :
    // aucune double acquisition, aucun déverrouillage anticipé — le verrou reste
    // détenu jusqu'à la fin de recover (comptes, état, retrait du marqueur).
    const { events } = buildView(root, { duringRecovery: true, heldLock: lock })
    atomicWrite(paths.state, JSON.stringify({ ...st, counts: { events, sessions: countSessionsFile(paths.sessions) } }, null, 2) + '\n')
    fs.rmSync(paths.marker, { force: true })
    // watermark opencode affiché depuis la forme multi-source (repli : forme plate)
    const oc = sourceStatesOf(st).opencode
    return {
      done: true,
      swept,
      note: `reprise explicite : vue reconstruite depuis le corpus tel qu'il est (${events} événements), watermark conservé (message=${oc?.message ?? '?'}, session=${oc?.session ?? '?'}) — la prochaine ingestion depuis la source convergera`
    }
  } finally {
    lock.release()
  }
}

/** Noms temporaires produits par le protocole, jamais un motif interne d'id. */
function isTemporaryCorpusFile (root, file) {
  const rel = path.relative(root, file)
  return /\.(jsonl|txt)\.new-\d+$/.test(rel) || /^index\.db\.new(?:-wal|-shm)?$/.test(rel) || /^state\.json\.tmp-\d+$/.test(rel)
}

/** Ramassage des temporaires orphelins à la passe suivante, sous verrou en
 *  réconciliation : staging des shards/preuves/métadonnées, vue réparée et
 *  écriture atomique de state.json. Un id canonique peut contenir `.tmp-` ou
 *  `.new-` : seuls les suffixes et chemins temporaires connus sont retirés. */
function sweepTemporaries (root) {
  const paths = corpusPaths(root)
  let n = 0
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      // Le fichier de verrou (lot A1, base SQLite) n'est jamais un temporaire de
      // corpus : ne pas le traiter ici (le verrou est géré par CorpusLock).
      if (e.isDirectory()) walk(p)
      else if (p !== paths.lock && isTemporaryCorpusFile(root, p)) { fs.rmSync(p, { force: true }); n++ }
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
  const piPath = sourcePi(opts.piDir)
  const paths = corpusPaths(root)
  // La RACINE seule est créée avant l'acquisition : le chemin du verrou doit être
  // créable. raw/ (et tout le reste du corpus) est créé APRÈS acquisition — lot A2 :
  // un refus du verrou ne crée rien dans le corpus.
  ensureDir(root)

  const lock = new CorpusLock(paths.lock)
  if (!lock.acquire()) {
    throw new Error(`une ingestion est déjà en cours sur ce corpus (verrou consultatif ${paths.lock}) — réessayer une fois la première terminée. Si son propriétaire est confirmé mort, retirer le fichier de verrou (et ses annexes -journal/-wal/-shm) manuellement UNIQUEMENT après arrêt coordonné de tous les utilisateurs du corpus, jamais sous concurrence`)
  }
  try {
    ensureDir(paths.raw) // déplacé après acquisition (lot A2)
    return await _ingest(root, paths, dbPath, piPath, opts)
  } finally {
    lock.release()
  }
}

async function _ingest (root, paths, dbPath, piPath, opts) {
  const rebuild = !!opts.rebuild
  const prevRaw = rebuild ? {} : readState(paths.state)
  // Forme multi-source normalisée : un state.json PLAT hérité (top-level
  // message/session) est interprété comme sources.opencode — migration écrite au
  // COMMIT de CETTE passe (design D2), sans re-ingestion forcée de l'opencode.
  const prevSources = sourceStatesOf(prevRaw)
  const prevOc = prevSources.opencode
  const prevPi = prevSources.pi
  const flatState = !rebuild && prevRaw.sources == null && (prevRaw.message != null || prevRaw.session != null)
  const prev = prevRaw
  // Un corpus v1 passe par la migration : refus explicite avec la marche à suivre.
  if (!rebuild && prev.layoutVersion != null) assertLayout(prev)
  if (!rebuild && prev.layoutVersion == null && fs.existsSync(paths.events) && !fs.existsSync(paths.eventsDir)) {
    throw new Error('corpus v1 détecté (events.jsonl sans events/) — lancer `sdig migrate` (sans la source) ou `sdig ingest --rebuild` (depuis la source)')
  }

  // ── Registre de sources (design D3 — sélection `all`, défaut ; la sélection
  // explicite --source est accueillie ici, ses options CLI arrivant à l'étape 3).
  // Validation AVANT la pose du marqueur (revue étape 2) : une erreur de
  // sélection, de présence ou d'accès n'est pas un échec de publication — le
  // corpus ne doit pas rester artificiellement « en ingestion » ; le marqueur
  // n'est conservé que pour un échec APRÈS début de publication.
  const requested = opts.source ?? 'all'
  if (requested !== 'all' && requested !== 'opencode' && requested !== 'pi') {
    throw new Error(`source inconnue : ${JSON.stringify(String(requested))} (all|opencode|pi)`)
  }
  const wants = (name) => requested === 'all' || requested === name
  const notes = []
  const active = new Set()
  // Erreurs d'accès ≠ absence : seul ENOENT signifie « absent » ; EACCES…
  // fait échouer la passe avec le chemin (jamais de publication à source muette).
  const ocExists = (() => {
    try { return fs.statSync(dbPath).isFile() } catch (e) {
      if (e && e.code === 'ENOENT') return false
      throw new Error(`source opencode illisible (${dbPath}) : ${e && e.message}`)
    }
  })()
  const piExists = (() => {
    try { return fs.statSync(piPath).isDirectory() } catch (e) {
      if (e && e.code === 'ENOENT') return false
      throw new Error(`source pi illisible (${piPath}) : ${e && e.message}`)
    }
  })()
  if (wants('opencode')) {
    if (ocExists) active.add('opencode')
    else if (requested === 'opencode') throw new Error(`source opencode introuvable : ${dbPath}`)
    else if (opts.db != null) throw new Error(`base source introuvable : ${dbPath}`)
    else notes.push(`source opencode absente : ${dbPath} — ignorée`)
  }
  if (wants('pi')) {
    if (piExists) active.add('pi')
    else if (requested === 'pi') throw new Error(`source pi introuvable : ${piPath}`)
    else if (opts.piDir != null) throw new Error(`répertoire source pi introuvable : ${piPath}`)
    else notes.push(`source pi absente : ${piPath} — ignorée`)
  }
  if (!active.size) {
    throw new Error(`aucune source présente : opencode (${dbPath}) introuvable, pi (${piPath}) introuvable — rien à ingérer`)
  }

  // ── Changement de chemin d'une source : invalidation de CETTE source seule
  // (relecture intégrale, signalée), l'autre conserve son watermark (design D2).
  // Chemin absent de l'état hérité (forme plate sans `source`) : on ne peut pas
  // conclure au re-pointage — watermark conservé, le delta jugera.
  let ocInvalidated = false
  let piInvalidated = false
  if (active.has('opencode') && prevOc && prevOc.path && prevOc.path !== dbPath) {
    ocInvalidated = true
    notes.push(`chemin de la source opencode changé (${prevOc.path} → ${dbPath}) — relecture intégrale de cette source`)
  }
  if (active.has('pi') && prevPi && prevPi.path && prevPi.path !== piPath) {
    piInvalidated = true
    notes.push(`chemin de la source pi changé (${prevPi.path} → ${piPath}) — relecture intégrale de cette source`)
  }
  if (flatState) notes.push('state.json de forme plate migré vers la forme multi-source (watermark opencode conservé)')

  // ── 0. marqueur AVANT tout remplacement ── ; ramassage des temporaires orphelins
  // UNIQUEMENT en réconciliation (passe corrective 20/09, revue : le ramassage
  // inconditionnel parcourait toute l'arborescence du corpus — O(#fichiers) — à
  // CHAQUE passe ; les temporaires n'existent que pendant une passe interrompue,
  // détectée par le marqueur). Posé APRÈS la validation du registre (revue étape 2 :
  // une erreur de sélection/présence n'est pas un échec de publication) mais AVANT
  // toute lecture/publication — un échec EN COURS DE PASSE le laisse posé, contrat
  // crash/réconciliation inchangé.
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
  // Watermark opencode de reprise : depuis l'état normalisé — conservé tel quel
  // en migration de forme plate ; -1 sur rebuild ou invalidation de chemin.
  const since = {
    message: (active.has('opencode') && !rebuild && !ocInvalidated && prevOc && Number.isFinite(prevOc.message)) ? prevOc.message : -1,
    session: (active.has('opencode') && !rebuild && !ocInvalidated && prevOc && Number.isFinite(prevOc.session)) ? prevOc.session : -1
  }
  // État pi antérieur : fichiers suivis (invalidés si la source a été re-pointée)
  const prevPiFiles = (active.has('pi') && !rebuild && !piInvalidated && prevPi && prevPi.files) ? prevPi.files : {}

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
  // Accus de la source pi (portée fonction : lus après le try/catch de publication)
  let piFiles = null
  let piOrphans = []
  let piIgnored = {}
  // Sources de l'état FINAL (calculées après le delta, avant le COMMIT)
  let finalSources = null
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
    // role 'title'. Retirée/réécrite quand le titre change ou disparaît — ou quand
    // la SOURCE change (add-pi-adapter, D1 : la ligne porte la source de sa
    // session ; une session migrée d'une source à l'autre réécrit sa ligne).
    const upsertTitleRow = (s) => {
      const source = s.source ?? 'opencode'
      const old = selEv.get(s.id)
      let sameTitle = false
      if (old) {
        try {
          const oldTitle = JSON.parse(old.json)
          sameTitle = oldTitle.text === (s.title ?? null) && (oldTitle.source ?? 'opencode') === source
        } catch { sameTitle = false }
      }
      if (old && !sameTitle) {
        if (usable) delFts.run(old.rid, old.text ?? '', old.cmd ?? '')
        delEv.run(s.id)
      }
      if (s.title && !sameTitle) {
        const tj = { schemaVersion: 1, source, id: s.id, sessionId: s.id, ts: s.tsCreated ?? s.tsUpdated ?? 0, role: 'title', text: s.title, repo: s.repo ?? null }
        const info = insEv.run(s.id, s.id, tj.ts, 'title', null, s.repo ?? null, null, null, s.title, JSON.stringify(tj))
        if (usable) insFts.run(info.lastInsertRowid, s.title, null)
      }
    }

    const delRef = vdb.prepare('DELETE FROM rawrefs WHERE eventId = ?')
    const upsertEvent = (e) => {
      const jsonLine = JSON.stringify(e)
      const old = selEv.get(e.id)
      if (old) {
        if (old.json === jsonLine) { counts.unchanged++; return } // idempotence : rien à faire
        if (usable) delFts.run(old.rid, old.text ?? '', old.cmd ?? '')
        // add-pi-adapter (revue) : les références de preuves de l'ANCIENNE version
        // sont retirées — un événement relu dont le rawRef a disparu ne doit plus
        // laisser une preuve scannable par --raw (réinsertion sélective ci-dessous).
        delRef.run(e.id)
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

    // ── 1. delta lu dans les sources actives, MÊME passe de publication ──
    // (design D2 : le protocole marqueur → staging → renames → COMMIT → state
    // couvre le delta des deux sources en une seule passe). Ordre déterministe :
    // opencode d'abord, pi ensuite — les id des deux espaces sont disjoints
    // (ses_* vs pi:*), le staging par session n'en est pas affecté.
    //
    // Les événements arrivent GROUPÉS PAR SESSION (adaptateur) : chaque session
    // est finalisée (shard fusionné + écrit) dès que le flux passe à la
    // suivante — jamais d'accumulation du delta entier en mémoire.
    const handleBatch = (batch) => {
      for (const s of batch.sessions) {
        // add-pi-adapter (D1) : toute ligne produite porte sa source — les lignes
        // opencode nouvellement écrites/réécrites sont marquées ici ; les lignes
        // existantes ne sont pas réécrites pour seule addition du champ.
        if (s.source == null) s.source = 'opencode'
        upsertSession(s)
        if (s.tsUpdated > maxSesUp) maxSesUp = s.tsUpdated
      }
      for (const e of batch.events) {
        if (e.source == null) e.source = 'opencode'
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
    }

    if (active.has('opencode')) {
      await adaptPaged(dbPath, since, {
        batchSize: Number(process.env.SDIG_INGEST_BATCH || 2000)
      }, handleBatch)
      finalizeCurrent()
    }

    // ── 1b. source pi (adaptateur dédié) : même staging, mêmes upserts ──
    if (active.has('pi')) {
      const piResult = adaptPi(piPath, { files: prevPiFiles }, {
        batchSize: Number(process.env.SDIG_INGEST_BATCH || 2000)
      }, (batch) => {
        for (const s of batch.sessions) {
          if (s.source == null) s.source = 'pi'
          upsertSession(s)
        }
        for (const e of batch.events) {
          if (e.source == null) e.source = 'pi'
          if (!cur || cur.sessionId !== e.sessionId) {
            finalizeCurrent()
            cur = { sessionId: e.sessionId, evs: new Map() }
          }
          cur.evs.set(e.id, e)
          upsertEvent(e)
        }
        for (const r of batch.rawOutputs) writeRaw(r)
        finalizeCurrent()
      })
      piFiles = piResult.files
      piOrphans = piResult.orphans || []
      piIgnored = piResult.ignored || {}
    }
    finalizeCurrent()

    // ── Sources de l'état FINAL : les actives sont mises à jour, les inactives
    // conservent leur état antérieur (jeton compris — la fraîcheur vue/state
    // reste exacte pour une source simplement absente de cette passe).
    finalSources = {}
    if (active.has('opencode')) {
      const message = Math.max(since.message, maxMsgUp)
      const session = Math.max(since.session, maxSesUp)
      finalSources.opencode = { path: dbPath, message, session, token: ocTokenOf(message, session) }
    } else if (prevOc) {
      finalSources.opencode = prevOc
    }
    if (active.has('pi')) {
      finalSources.pi = { path: piPath, files: piFiles, token: piTokenOf(piFiles) }
    } else if (prevPi) {
      finalSources.pi = prevPi
    }
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
  // Watermark PAR SOURCE (design D2) : une ligne par source de l'état final —
  // jeton de fraîcheur ; opencode conserve en plus ses epochs. Les sources
  // inactives cette passe portent leur état inchangé (jeton conservé).
  vdb.prepare('DELETE FROM watermark').run()
  for (const [name, s] of Object.entries(finalSources)) {
    vdb.prepare('INSERT INTO watermark (source, token, message, session) VALUES (?,?,?,?)')
      .run(name, s.token, s.message ?? null, s.session ?? null)
  }
  vdb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('layoutVersion', String(LAYOUT_VERSION))
  // Identité de génération publiée : jeton ALÉATOIRE renouvelé DANS la transaction
  // (rollback ⇒ génération précédente conservée). Seul témoin explicite du producteur.
  vdb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(GENERATION_KEY, newGeneration())
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
    layoutVersion: LAYOUT_VERSION,
    updatedAt: Date.now(),
    counts: totals,
    sources: finalSources
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
    sources: finalSources,
    notes,
    pi: active.has('pi')
      ? { path: piPath, files: Object.keys(piFiles).length, orphans: piOrphans, ignored: piIgnored }
      : null,
    migratedFromFlat: flatState,
    watermark: {
      message: finalSources.opencode?.message ?? -1,
      session: finalSources.opencode?.session ?? -1
    },
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
  // Lot A2 : verrou acquis AVANT l'état, les contrôles et les mutations — Y COMPRIS
  // sur le chemin « déjà v2 » (shardFlatRaws renomme des fichiers de raw/). Refus du
  // marqueur non réconcilié SOUS verrou : une migration ne s'applique jamais sur un
  // état non publié ; recover reste le seul parcours autorisé sous un marqueur.
  const lock = new CorpusLock(paths.lock)
  if (!lock.acquire()) throw new Error(`une opération corpus est déjà en cours (verrou consultatif ${paths.lock}) — réessayer plus tard. Si son propriétaire est confirmé mort, retirer le fichier de verrou (et ses annexes -journal/-wal/-shm) manuellement UNIQUEMENT après arrêt coordonné de tous les utilisateurs du corpus, jamais sous concurrence`)
  try {
    if (ingestRunning(root)) {
      throw new Error("ingestion en cours non réconciliée (marqueur présent) — réconcilier d'abord : relancer `sdig ingest` ou `sdig ingest --recover`")
    }
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
    // Le verrou DÉJÀ DÉTENU est transmis à buildView (instance validée, jamais un
    // booléen) : aucune double acquisition, aucun déverrouillage anticipé — libéré
    // par le finally de migrate, en tout dernier, après état et retrait du marqueur.
    buildView(root, { duringRecovery: true, heldLock: lock })
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
 *
 * Lot A2 : le verrou est acquis AVANT tout contrôle et parcours — le refus du
 * marqueur et la marche de lecture ont lieu SOUS verrou, libéré en finally sur
 * succès et erreur.
 */
export function fingerprint (root = corpusPaths().root) {
  const paths = corpusPaths(root)
  const lock = new CorpusLock(paths.lock)
  if (!lock.acquire()) {
    throw new Error(`une opération corpus est déjà en cours (verrou consultatif ${paths.lock}) — réessayer une fois terminée. Si son propriétaire est confirmé mort, retirer le fichier de verrou (et ses annexes -journal/-wal/-shm) manuellement UNIQUEMENT après arrêt coordonné de tous les utilisateurs du corpus, jamais sous concurrence`)
  }
  try {
    if (ingestRunning(root)) {
      throw new Error("ingestion en cours non réconciliée (marqueur présent) — l'empreinte ne peut pas faire foi sur un état non publié : relancer `sdig ingest` ou `sdig ingest --recover`")
    }
    const DERIVED = /^(index\.db|\.ingest-lock)(-wal|-shm|-journal)?$/
    const files = []
    const walk = (dir, rel = '') => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name
        // Le verrou (fichier `.ingest-lock`, base SQLite du lot A1) et ses annexes
        // (`-journal`/`-wal`/`-shm`) sont dérivés et jetables : exclus de l'empreinte.
        if (e.isDirectory()) walk(path.join(dir, e.name), r)
        else if (!DERIVED.test(r) && !isTemporaryCorpusFile(root, path.join(dir, e.name))) files.push([r, path.join(dir, e.name)])
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
  } finally {
    lock.release()
  }
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
