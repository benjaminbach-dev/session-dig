// Adaptateur opencode paginé (change scale-corpus) : lecture de la source par lots
// bornés, watermark EN REQUÊTE (filtre time_updated exécuté par la base — jamais un
// parcours complet des tables filtré après coup). La mémoire est bornée par la taille
// de lot, indépendamment de la taille de la source (la base PC réelle fait 4 Go :
// aucune matérialisation intégrale).
//
// Stratégie de lecture du delta (D3) : la PAGINATION DES SESSIONS est keyset sur
// (time_updated, id) quand la table `session` porte un index dont time_updated est
// la PREMIÈRE colonne clé — coût indexé pour cette table seulement. Sinon, la table
// légère est parcourue par clé (id) par lots bornés.
//
// La requête des MESSAGES du delta (`ORDER BY session_id, time_created, id`) peut
// SCANNER même si un index time_updated existe : l'ordre demandé n'est pas fourni
// par cet index (banc du 06/10 : plan inchangé, `SCAN message USING INDEX
// message_session_idx`). Aucune promesse d'O(delta) sur les messages : le plan
// dépend de SQLite et du coût par plage, pas d'une intention.
//
// Lecture source STRICTE en lecture seule (voir `source-db.js`) : aucun repli par
// copie temporaire db/-wal/-shm.
// L'extraction d'un message (parts → événement canonique) reste dans
// opencode-extract.js (point de vérité unique partagé).
import path from 'node:path'
import os from 'node:os'
import { extractSessionRow, extractMessage } from './opencode-extract.js'
import { openReadonlySource } from './source-db.js'

function repoFromDirectory (directory) {
  if (!directory || directory === '/' || directory === os.homedir()) return null
  return path.basename(directory) || null
}

/**
 * La table `session` porte-t-elle un index dont la PREMIÈRE colonne clé est
 * `time_updated` ? Seule cette table utilise le drapeau (pagination keyset des
 * sessions). Détection par PRAGMA, jamais par inspection de texte SQL :
 *   - `pragma_index_list('session')` : index non partiels uniquement (un index
 *     partiel ne couvre pas toute la table) ;
 *   - `pragma_index_xinfo(<nom échappé>)` : première colonne clé (`key=1`, plus
 *     petit `seqno`) — une expression ou une colonne en queue ne compte pas.
 * Un index sur `message` n'est jamais considéré (table distincte).
 */
function hasTimeUpdatedIndex (db) {
  const q = (s) => `'${String(s).replaceAll("'", "''")}'` // échappement du nom d'index
  const idx = db.prepare("SELECT name, partial FROM pragma_index_list('session')").all()
  for (const row of idx) {
    if (row.partial) continue // index partiel : ne couvre pas toute la table
    const cols = db.prepare(`SELECT seqno, name, key FROM pragma_index_xinfo(${q(row.name)})`).all()
    const firstKey = cols.filter(c => c.key === 1).sort((a, b) => a.seqno - b.seqno)[0]
    if (firstKey && firstKey.name === 'time_updated') return true
  }
  return false
}

export async function adaptPaged (dbPath, since = {}, opts = {}, onBatch) {
  const sinceMsg = since.message ?? -1
  const sinceSes = since.session ?? -1
  const batchSize = Math.max(1, opts.batchSize || 2000)
  const db = openReadonlySource(dbPath)
  try {
    const indexed = hasTimeUpdatedIndex(db)

    // ── sessions (table légère, pagination par clé en TOUTES configurations) ──
    // Passe corrective 20/09 (revue) : sans index time_updated, l'ancienne version ne
    // lisait QU'UN SEUL lot (2000 sessions) puis s'arrêtait — au-delà, des sessions
    // étaient omises SILENCIEUSEMENT et le watermark les rendait définitivement
    // invisibles. La boucle pagine désormais par clé : (time_updated, id) si l'index
    // existe, sinon (id) — jusqu'à épuisement, par lots bornés.
    const sesQ = indexed
      ? db.prepare(`SELECT * FROM session
      WHERE time_updated > ? AND (time_updated > ? OR (time_updated = ? AND id > ?))
      ORDER BY time_updated, id LIMIT ?`)
      : db.prepare(`SELECT * FROM session WHERE time_updated > ? AND id > ? ORDER BY id LIMIT ?`)
    let lastUp = -1
    let lastId = ''
    for (;;) {
      const rows = indexed
        ? sesQ.all(sinceSes, lastUp, lastUp, lastId, batchSize)
        : sesQ.all(sinceSes, lastId, batchSize)
      if (!rows.length) break
      const maxUp = Math.max(-1, ...rows.map(r => r.time_updated ?? -1))
      onBatch({
        sessions: rows.map(extractSessionRow),
        events: [],
        rawOutputs: [],
        maxMessageUpdate: -1,
        maxSessionUpdate: maxUp
      })
      lastUp = maxUp
      lastId = rows[rows.length - 1].id
      if (rows.length < batchSize) break
    }

    // ── messages : delta filtré PAR LA BASE (watermark en requête), GROUPÉS PAR SESSION ──
    // Passe corrective 20/09 (revue) : ORDER BY session_id, time_created, id — les
    // événements d'une session arrivent CONTIGUS (l'index source (session_id,
    // time_created, id) sert d'ordre, pas de tri en mémoire) : l'ingestion peut
    // vider chaque session du flux au fil de l'eau au lieu d'accumuler le delta
    // entier en RAM (le défaut : première ingestion = corpus entier en mémoire).
    // event.ts = message.time_created : l'ordre d'arrivée est exactement l'ordre (ts, id)
    // des shards.
    const msgQ = db.prepare(`SELECT * FROM message WHERE time_updated > ? ORDER BY session_id, time_created, id`)

    const repoQ = db.prepare('SELECT directory FROM session WHERE id = ?')
    const repoCache = new Map()
    const REPO_CACHE_MAX = 5000
    const repoOf = (sessionId) => {
      if (repoCache.has(sessionId)) return repoCache.get(sessionId)
      const row = repoQ.get(sessionId)
      const repo = row ? repoFromDirectory(row.directory) : null
      if (repoCache.size >= REPO_CACHE_MAX) repoCache.clear()
      repoCache.set(sessionId, repo)
      return repo
    }

    const partQ = db.prepare('SELECT id, data FROM part WHERE message_id = ? ORDER BY id')

    let events = []
    let rawOutputs = []
    let batchMaxUp = -1
    const flush = () => {
      onBatch({
        sessions: [], events, rawOutputs,
        maxMessageUpdate: batchMaxUp, maxSessionUpdate: -1
      })
      events = []
      rawOutputs = []
      batchMaxUp = -1
    }
    for (const m of msgQ.iterate(sinceMsg)) {
      if (m.time_updated > batchMaxUp) batchMaxUp = m.time_updated
      repoCache.delete(m.session_id) // une session peut changer de directory
      const parts = partQ.all(m.id).map(p => {
        let data
        try { data = JSON.parse(p.data) } catch { return null }
        return { rowId: p.id, data }
      }).filter(Boolean)
      const r = extractMessage(m, parts, repoOf)
      if (r) {
        if (r.event) events.push(r.event)
        for (const ro of r.rawOutputs) rawOutputs.push(ro)
      }
      if (events.length >= batchSize) flush()
    }
    if (events.length) flush()
  } finally {
    db.close()
  }
}
