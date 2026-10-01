// Vue dérivable SQLite (change scale-corpus) : chemin de lecture unique du CLI.
// L'index — aujourd'hui dédié à la recherche — s'étend en vue de lecture : JSON
// intégral par événement, métadonnées de sessions, références de preuves brutes,
// FTS5 inchangé. Elle porte en son sein le watermark du corpus auquel elle
// correspond, est maintenue incrémentalement pendant l'ingestion (dans la
// transaction de publication) et reste entièrement reconstruisable depuis le
// seul corpus (contrat d'index jetable inchangé).
//
// Lignes de titre : une ligne synthétique par session (id = id de session,
// role 'title') — décision du 17/09 motivée par l'éval, inchangée. Les compteurs
// de lecture (total, visible, maskedCount) excluent ces lignes (role != 'title').
// L'ordre de lecture d'une session est (ts, id) — celui du shard.
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { corpusPaths } from './paths.js'
import { streamLines } from './util.js'
import { listShards, assertLayout, ingestRunning } from './layout.js'
import { CorpusLock, assertHeldLock } from './lock.js'

export const SCHEMA = `
  CREATE TABLE meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE sessions(
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    title TEXT, repo TEXT, tsCreated INTEGER, tsUpdated INTEGER,
    directory TEXT, cost REAL, parentSession TEXT
  );
  CREATE TABLE events(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    role TEXT, agent TEXT, repo TEXT, model TEXT, cmd TEXT, text TEXT,
    json TEXT NOT NULL
  );
  CREATE INDEX events_session_key ON events(session_id, ts, id);
  CREATE INDEX events_ts ON events(ts);
  CREATE VIRTUAL TABLE events_fts USING fts5(text, cmd, content='events', content_rowid='rowid');
  CREATE TABLE rawrefs(
    rawRef TEXT PRIMARY KEY,
    eventId TEXT, sessionId TEXT, ts INTEGER, role TEXT, tool TEXT, cmd TEXT
  );
  CREATE TABLE watermark(
    source TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    message INTEGER,
    session INTEGER
  );
`

export function viewPath (root = corpusPaths().root) {
  return path.join(root, 'index.db')
}

export function viewExists (root = corpusPaths().root) {
  return fs.existsSync(viewPath(root))
}

export function openViewWrite (root = corpusPaths().root, dbFile = viewPath(root)) {
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  return db
}

// ── Jetons de fraîcheur par source (design D2) : condensat déterministe de
// l'état incrémental de la source. opencode : md5(message\0session) ; pi :
// md5 de l'ensemble TRIÉ des entrées files (relPath\0size\0mtimeMs). Un jeton
// n'a pas d'ordre — l'égalité vue/state est la fraîcheur.
export function ocTokenOf (message, session) {
  return crypto.createHash('md5').update(`${message}\0${session}`).digest('hex')
}
export function piTokenOf (files = {}) {
  const h = crypto.createHash('md5')
  for (const rel of Object.keys(files).sort()) {
    const f = files[rel] || {}
    h.update(`${rel}\0${f.size ?? -1}\0${f.mtimeMs ?? -1}\n`)
  }
  return h.digest('hex')
}

/**
 * Normalise un state.json en forme multi-source (design D2). Une forme PLATE
 * héritée (top-level message/session — le champ `source` le confirme) est
 * interprétée comme sources.opencode, sans re-ingestion forcée : les watermarks
 * opencode sont conservés tels quels ; la forme multi-source est écrite au
 * COMMIT de la première ingestion qui suit. Les jetons manquants sont calculés.
 */
export function sourceStatesOf (rawState) {
  const st = rawState && typeof rawState === 'object' ? rawState : {}
  const out = {}
  if (st.sources && typeof st.sources === 'object') {
    for (const [name, s] of Object.entries(st.sources)) {
      if (!s || typeof s !== 'object') continue
      if (name === 'opencode') {
        const message = Number.isFinite(s.message) ? s.message : -1
        const session = Number.isFinite(s.session) ? s.session : -1
        out.opencode = { ...s, message, session, token: s.token ?? ocTokenOf(message, session) }
      } else if (name === 'pi') {
        const files = (s.files && typeof s.files === 'object') ? s.files : {}
        out.pi = { ...s, files, token: s.token ?? piTokenOf(files) }
      }
    }
    return out
  }
  if (st.message != null || st.session != null) {
    const message = Number.isFinite(st.message) ? st.message : -1
    const session = Number.isFinite(st.session) ? st.session : -1
    return { opencode: { path: st.source, message, session, token: ocTokenOf(message, session) } }
  }
  return {}
}

/** La table watermark de la vue porte-t-elle la forme par source ? */
function watermarkHasSourceColumn (db) {
  const cols = db.prepare('PRAGMA table_info(watermark)').all().map(c => c.name)
  return cols.includes('source') && cols.includes('token')
}

/** La vue existe-t-elle avec le schéma v2 complet ? */
export function viewHasSchema (db) {
  const hasMeta = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='meta'").get().n > 0
  if (!hasMeta) return false
  const cols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name)
  return cols.includes('json') && cols.includes('session_id')
}

/** La vue courante existe et porte le schéma v2 + un watermark + la bonne version. */
export function viewIsCurrent (root = corpusPaths().root) {
  const dbFile = viewPath(root)
  if (!fs.existsSync(dbFile)) return false
  let db
  try { db = new Database(dbFile, { readonly: true, fileMustExist: true }) } catch { return false }
  try {
    if (!viewHasSchema(db)) return false
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('layoutVersion')
    if (!row || Number(row.value) !== 2) return false
    // add-pi-adapter : watermark par source (jeton) — une vue de forme antérieure
    // (watermark mono-ligne) n'est pas courante : jetable, elle est reconstruite.
    if (!watermarkHasSourceColumn(db)) return false
    return db.prepare('SELECT COUNT(*) n FROM watermark').get().n > 0
  } catch {
    return false
  } finally {
    db.close()
  }
}

/**
 * Ouvre la vue en lecture et vérifie version + fraîcheur : refus explicite si
 * absente, de mauvaise version ou périmée (motif + instruction de réparation) —
 * jamais de données décalées rendues en silence.
 */
export function openView (root = corpusPaths().root, dbFile = viewPath(root)) {
  if (!fs.existsSync(dbFile)) {
    throw new Error(`vue dérivable absente : ${dbFile} — lancer \`sdig refresh\` pour la construire depuis le corpus`)
  }
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  if (!viewHasSchema(db)) {
    db.close()
    throw new Error('vue de version antérieure (index v0) — reconstruire avec `sdig refresh`')
  }
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('layoutVersion')
  const got = row ? Number(row.value) : 1
  if (got !== 2) {
    db.close()
    throw new Error(`vue de layout non support : lu v${got}, attendu v2 — reconstruire avec \`sdig refresh\``)
  }
  if (!watermarkHasSourceColumn(db)) {
    db.close()
    throw new Error('vue de forme antérieure (watermark mono-source) — reconstruire avec `sdig refresh`')
  }
  const wm = db.prepare('SELECT COUNT(*) n FROM watermark').get()
  if (!wm || wm.n === 0) {
    db.close()
    throw new Error('vue sans watermark — reconstruire avec `sdig refresh`')
  }
  const fresh = checkFresh(root, { db })
  if (!fresh.fresh) {
    db.close()
    throw new Error(fresh.reason)
  }
  return db
}

/**
 * Fraîcheur : la vue porte le watermark du corpus auquel elle correspond.
 * Limite écrite : le watermark couvre le chemin d'ingestion documenté — une
 * modification hors ingestion (shard édité à la main, watermark inchangé) n'est
 * pas détectée ici ; l'outil de détection est l'empreinte du corpus
 * (`sdig fingerprint`), pas le watermark.
 */
export function checkFresh (root = corpusPaths().root, { db = null } = {}) {
  const own = db == null
  const v = db ?? openView(root)
  try {
    if (!watermarkHasSourceColumn(v)) {
      return { fresh: false, reason: 'vue de forme antérieure (watermark mono-source) — reconstruire avec `sdig refresh`' }
    }
    const rows = new Map(v.prepare('SELECT source, token, message, session FROM watermark').all().map(r => [r.source, r]))
    if (!rows.size) return { fresh: false, reason: 'vue sans watermark — reconstruire avec `sdig refresh`' }
    const stPath = corpusPaths(root).state
    let st = {}
    try { st = JSON.parse(fs.readFileSync(stPath, 'utf8')) } catch {
      return { fresh: false, reason: 'corpus sans state.json lisible — relancer une ingestion' }
    }
    // Fraîcheur PER-SOURCE (design D2) : une vue en retard sur UNE source est en
    // retard, point. Un jeton n'a pas d'ordre — pour pi, l'égalité fait foi ;
    // opencode conserve ses epochs ORDONNABLES : vue en avance (crash entre COMMIT
    // et state.json) = état publié valide, tolérée ; vue en retard = refusée.
    const sources = sourceStatesOf(st)
    // Première publication d'une source à jeton non ordonnable : sa ligne peut
    // déjà être COMMITée alors qu'elle est encore absente de state.json.
    for (const name of rows.keys()) {
      if (name !== 'opencode' && !Object.hasOwn(sources, name)) {
        return { fresh: false, reason: `vue en avance sur la source ${name} (jeton absent de l'état publié) — lancer \`sdig refresh\`` }
      }
    }
    for (const [name, s] of Object.entries(sources)) {
      const row = rows.get(name)
      if (!row) {
        return { fresh: false, reason: `vue sans jeton de fraîcheur pour la source ${name} — lancer \`sdig refresh\`` }
      }
      if (name === 'opencode') {
        if ((s.message ?? -1) > (row.message ?? -1) || (s.session ?? -1) > (row.session ?? -1)) {
          return { fresh: false, reason: `vue en retard sur la source opencode (vue message=${row.message}/session=${row.session}, corpus message=${s.message}/session=${s.session}) — lancer \`sdig refresh\`` }
        }
      } else if (row.token !== s.token) {
        return { fresh: false, reason: `vue en retard sur la source ${name} (jeton divergent) — lancer \`sdig refresh\`` }
      }
    }
    return { fresh: true, watermark: Object.fromEntries(rows) }
  } finally {
    if (own) v.close()
  }
}

/** Colonnes indexables d'un événement (partagées maintenance incrémentale / build). */
export function eventCols (e) {
  const cmds = (e.toolCalls || []).map(c => c.cmd).filter(Boolean).join('\n')
  const model = e.model && (e.model.providerID || e.model.modelID)
    ? `${e.model.providerID || ''}/${e.model.modelID || ''}`
    : null
  return { cmds: cmds || null, model }
}

/**
 * Passe corrective 20/09 (revue) : UNE commande = UNE transaction de lecture.
 * Partager une connexion SQLite ne partage PAS une transaction : sans BEGIN, chaque
 * instruction vit dans sa propre transaction et une publication concurrente peut
 * s'intercaler entre hits, voisins et compteurs — exactement le mélange de générations
 * que la spec interdit au sein d'une lecture. En WAL, une transaction de lecture
 * ouverte voit TOUJOURS le même snapshot, quelles que soient les publications
 * concurrentes, jusqu'à son COMMIT. Les commandes passent aussi `root` pour
 * revalider la fraîcheur dans ce snapshot avant d'exécuter leur callback.
 */
export function inReadTx (db, fn, { root = null } = {}) {
  db.exec('BEGIN')
  try {
    // openView a vérifié la fraîcheur avant BEGIN : une publication peut s'être
    // intercalée depuis. Revalider le snapshot lui-même avant toute donnée rendue.
    if (root != null) {
      const fresh = checkFresh(root, { db })
      if (!fresh.fresh) throw new Error(fresh.reason)
    }
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

/**
 * La vue est-elle UTILISABLE comme base de la passe d'ingestion ? Passe corrective
 * 20/09 (revue) : l'ancien test (viewIsCurrent) ne vérifiait ni la fraîcheur ni la
 * complétude — une vue ABSENTE ou EN RETARD sur state.json faisait repartir l'ingestion
 * d'une vue VIDE : les anciens événements restaient dans les shards mais devenaient
 * invisibles dans une vue déclarée fraîche. Utilisable = schéma v2 + watermark présent
 * + watermark de vue ≥ watermark de state (une vue en avance — crash entre COMMIT et
 * state.json — est un état publié valide, le delta s'y ré-applique idempotemment).
 */
export function viewUsableForIngest (root = corpusPaths().root) {
  if (!viewIsCurrent(root)) return false
  let db
  try { db = new Database(viewPath(root), { readonly: true, fileMustExist: true }) } catch { return false }
  try {
    if (!watermarkHasSourceColumn(db)) return false
    const rows = new Map(db.prepare('SELECT source, token, message, session FROM watermark').all().map(r => [r.source, r]))
    if (!rows.size) return false
    let st = {}
    try { st = JSON.parse(fs.readFileSync(corpusPaths(root).state, 'utf8')) } catch { return true }
    // Per-source : une source de l'état sans ligne dans la vue rend la vue
    // inutilisable comme base (reconstruction depuis le corpus). opencode : les
    // epochs sont ordonnables — vue EN AVANCE (crash entre COMMIT et state.json)
    // tolérée, état publié valide. pi : jeton sans ordre — l'égalité est exigée ;
    // la divergence (vue en avance comme en retard) déclenche une reconstruction
    // depuis les shards, qui est elle-même idempotente (design D2, jetons compris).
    for (const [name, s] of Object.entries(sourceStatesOf(st))) {
      const row = rows.get(name)
      if (!row) return false
      if (name === 'opencode') {
        if ((s.message ?? -1) > (row.message ?? -1) || (s.session ?? -1) > (row.session ?? -1)) return false
      } else if (row.token !== s.token) {
        return false
      }
    }
    return true
  } catch {
    return false
  } finally {
    db.close()
  }
}

/**
 * Population d'une vue OUVERTE depuis le seul corpus, EN FLUX (passe corrective :
 * extraite de buildView pour servir aussi la réparation pendant l'ingestion — une
 * vue absente/périmée est reconstruite depuis les shards AVANT d'y appliquer le
 * delta). N'écrit PAS dans events_fts : l'appelant exécute le rebuild FTS une fois
 * toutes les insertions faites (contenu externe → 'rebuild' repart du contenu).
 * Repli v1 : sans shards, lit events.jsonl (corpus de test / pré-migration).
 * Retourne le nombre d'événements (hors lignes de titre).
 */
export function populateView (db, root = corpusPaths().root) {
  const paths = corpusPaths(root)

  const insSes = db.prepare('INSERT INTO sessions (id, json, title, repo, tsCreated, tsUpdated, directory, cost, parentSession) VALUES (?,?,?,?,?,?,?,?,?)')
  const insEv = db.prepare('INSERT INTO events (id, session_id, ts, role, agent, repo, model, cmd, text, json) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const insRef = db.prepare('INSERT OR REPLACE INTO rawrefs (rawRef, eventId, sessionId, ts, role, tool, cmd) VALUES (?,?,?,?,?,?,?)')

  const insertEvent = (e, jsonLine) => {
    const { cmds, model } = eventCols(e)
    insEv.run(e.id, e.sessionId, e.ts, e.role ?? null, e.agent ?? null, e.repo ?? null, model, cmds, e.text ?? '', jsonLine)
    for (const c of e.toolCalls || []) {
      if (c.rawRef) insRef.run(String(c.rawRef), e.id, e.sessionId, e.ts, e.role ?? null, c.tool ?? null, c.cmd ?? null)
    }
  }

  let count = 0
  const insertAll = db.transaction(() => {
    streamLines(paths.sessions, (line) => {
      const s = JSON.parse(line)
      insSes.run(s.id, line, s.title ?? null, s.repo ?? null, s.tsCreated ?? null, s.tsUpdated ?? null, s.directory ?? null, s.cost ?? null, s.parentSession ?? null)
      // ligne de titre synthétique (décision 17/09) : role 'title', jamais comptée.
      // add-pi-adapter (D1) : elle porte la source de sa session — les sessions
      // héritées du corpus, sans champ, sont lues comme opencode.
      if (s.title) {
        const source = s.source ?? 'opencode'
        insertEvent({
          id: s.id, sessionId: s.id, ts: s.tsCreated ?? s.tsUpdated ?? 0, role: 'title',
          repo: s.repo ?? null, text: s.title
        }, JSON.stringify({ schemaVersion: 1, source, id: s.id, sessionId: s.id, ts: s.tsCreated ?? s.tsUpdated ?? 0, role: 'title', text: s.title, repo: s.repo ?? null }))
      }
    })
    const shards = listShards(root)
    if (shards.length) {
      for (const rel of shards) {
        streamLines(path.join(root, rel), (line) => { insertEvent(JSON.parse(line), line); count++ })
      }
    } else if (fs.existsSync(paths.events)) {
      // corpus v1 (tests / pré-migration) : flux sur le fichier unique
      streamLines(paths.events, (line) => { insertEvent(JSON.parse(line), line); count++ })
    }
  })
  insertAll()
  return count
}

/**
 * Rebuild complet de la vue depuis le seul corpus (référence de réparation).
 * En flux (jamais le corpus entier en RAM) ; déterministe ; FTS5 inchangé
 * ('rebuild' externe sur le contenu, comme l'index v0). Retourne { events, dbFile }.
 * Tolère un état absent (corpus de test brut) : watermark (-1, -1).
 * Repli v1 : sans shards, lit events.jsonl (corpus de test / pré-migration).
 *
 * Passe corrective 20/09 (revue) : REFUSE de reconstruire tant qu'une ingestion est
 * non réconciliée (marqueur présent) — sinon le rebuild transformerait un état non
 * publié (shards partiellement remplacés) en référence, précisément ce que les specs
 * interdisent. La reprise explicite (`sdig ingest --recover`) passe duringRecovery :
 * c'est une décision d'opérateur, pas un défaut.
 *
 * Lot A2 : le verrou est acquis AVANT tout contrôle, parcours et mutation — le refus
 * du marqueur et le retrait de l'index ont lieu SOUS verrou, libéré en finally sur
 * succès, refus et erreur. duringRecovery ne désactive PAS le verrou : il ne dispense
 * que du garde-fou marqueur (recover/migrate, opérateurs sous leur propre marqueur).
 * Un verrou déjà détenu peut être TRANSMIS (`heldLock`) — recover/migrate — validé
 * fortement (instance CorpusLock, effectivement détenue, chemin du verrou du corpus
 * cible) : jamais un simple booléen `lock: true`, qui contournerait l'exclusion.
 */
export function buildView (root = corpusPaths().root, { dbFile = viewPath(root), duringRecovery = false, heldLock = null } = {}) {
  const paths = corpusPaths(root)
  const own = heldLock == null
  if (!own) assertHeldLock(heldLock, paths.lock)
  const lock = own ? new CorpusLock(paths.lock) : heldLock
  if (own && !lock.acquire()) {
    throw new Error(`une opération corpus est déjà en cours (verrou consultatif ${paths.lock}) — réessayer une fois terminée. Si son propriétaire est confirmé mort, retirer ce fichier manuellement UNIQUEMENT après arrêt coordonné de tous les utilisateurs du corpus, jamais sous concurrence`)
  }
  try {
    if (!duringRecovery && ingestRunning(root)) {
      throw new Error("ingestion en cours non réconciliée (marqueur présent) — relancer `sdig ingest` (réconciliation idempotente) ou `sdig ingest --recover` (reprise explicite) AVANT de reconstruire : un rebuild ne doit jamais faire d'un état non publié la référence")
    }
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true })
    const db = openViewWrite(root, dbFile)
    try {
      db.exec(SCHEMA)
      let state = {}
      try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')) } catch { state = {} }
      if (state.layoutVersion != null) assertLayout(state)

      const count = populateView(db, root)

      db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`)

      db.transaction(() => {
        db.prepare('INSERT INTO meta (key, value) VALUES (?,?)').run('layoutVersion', '2')
        for (const [name, s] of Object.entries(sourceStatesOf(state))) {
          db.prepare('INSERT INTO watermark (source, token, message, session) VALUES (?,?,?,?)')
            .run(name, s.token, s.message ?? null, s.session ?? null)
        }
      })()
      db.pragma('wal_checkpoint(TRUNCATE)')
      return { events: count, dbFile }
    } finally {
      db.close()
    }
  } finally {
    if (own) lock.release()
  }
}

export { assertLayout }
