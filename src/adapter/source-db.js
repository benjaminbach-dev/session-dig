// Ouverture en LECTURE SEULE STRICTE d'une base source SQLite (opencode.db),
// partagée par les deux adaptateurs opencode (`opencode.js` et `opencode-page.js`).
//
// Contrat corpus/spec.md (« Adaptateur opencode ») : la base source est lue
// « sans jamais écrire, copier ou verrouiller durablement ». Aucun repli par copie
// temporaire de `db`/`-wal`/`-shm` : une copie séquentielle ne garantit aucun
// snapshot cohérent et écrit des fichiers — elle est INTERDITE. Un opencode
// concurrent autorise réussir en lecture seule (WAL) ou échouer proprement ; jamais
// de demi-état silencieux.
//
// L'ouverture est `new Database(dbPath, { readonly: true, fileMustExist: true })`.
// Si le constructeur ouvre un fichier non-SQLite (garbage), la première requête est
// validée EN LECTURE (`sqlite_schema`) ; en cas d'échec, la connexion est refermée
// et l'erreur est EXPLICITE (chemin, code, action) — jamais de conseil de suppression
// des fichiers source.
import fs from 'node:fs'
import Database from 'better-sqlite3'

const RETRY_ACTION = "vérifier l'accès en lecture au fichier et l'état d'opencode, puis réessayer"

/** Message d'échec explicite : chemin + code (ou message) + action, sans conseil destructif. */
function openError (dbPath, e, kind) {
  const code = e && e.code ? e.code : (e && e.message) ? e.message : 'inconnu'
  return new Error(`base source ${kind} : ${dbPath} (${code}) — ${RETRY_ACTION}`)
}

/**
 * Ouvre la base source en lecture seule stricte. Lève une erreur explicite si la
 * base est absente, illisible en lecture seule, ou n'est pas une base SQLite
 * (schéma illisible). La connexion retournée appartient à l'appelant, qui DOIT la
 * fermer (`finally`).
 */
export function openReadonlySource (dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`base source introuvable : ${dbPath} (lancer opencode au moins une fois, ou passer --db)`)
  }
  let db
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch (e) {
    throw openError(dbPath, e, 'illisible en lecture seule')
  }
  // Validation EN LECTURE : un fichier non-SQLite peut s'ouvrir puis échouer à la
  // première requête. On referme et on échoue explicitement, sans rien écrire.
  try {
    db.prepare('SELECT name FROM sqlite_schema LIMIT 1').get()
  } catch (e) {
    try { db.close() } catch { /* fermeture best-effort avant de lever */ }
    throw openError(dbPath, e, 'non lisible en lecture seule (schéma)')
  }
  return db
}
