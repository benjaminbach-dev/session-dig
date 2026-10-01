// Verrou consultatif de corpus (extrait de corpus.js — lot A2) : module partagé
// sans cycle, importé par corpus.js (réexport pour compat) et view.js (buildView).
//
// ── Lot A1 — exclusion des écrivains par VERROU NOYAU (better-sqlite3).
//
// Le fichier `.ingest-lock` est une base SQLite dédiée. Le VERROU est le verrou
// exclusif du noyau (fcntl) : `locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE` …
// `COMMIT` ; la connexion le conserve tant qu'elle est ouverte, un second
// processus reçoit `SQLITE_BUSY` et refuse. Le fichier n'est JAMAIS supprimé par
// le protocole.
//
// Contrat d'acquisition (spec A1) — distinguer création neuve et artefact existant :
//   - chemin ABSENT : réservation exclusive `open(O_CREAT|O_EXCL)` (wx) ; seul le
//     créateur initialise le schéma (`CREATE TABLE`), puis prend le verrou noyau
//     et écrit la trace propriétaire. Une course de première initialisation se
//     solde par un refus de l'autre (fichier déjà présent → validation, jamais
//     d'initialisation par un non-créateur).
//   - chemin DÉJÀ PRÉSENT : aucune écriture de structure. Rejet d'emblée si
//     symlink ou non-fichier (cible intacte) ; sinon validation LECTURE SEULE du
//     schéma attendu, puis seulement le verrou noyau et la trace. Un artefact
//     vide, illisible, un autre schéma, une base SQLite étrangère ⇒ REFUS
//     conservateur, sans remplissage ni mutation.
//
// Reprise : une trace propriétaire COMMITÉE qui subsiste alors que le verrou
// noyau est libre ⇒ refus conservateur (aucune reprise automatique sur un PID).
// Reprise opérateur = retirer le fichier de verrou (et ses annexes
// `-journal`/`-wal`/`-shm`) après arrêt coordonné de TOUS les utilisateurs.
//
// Frontières d'arrêt brutal (aucune promesse que « tout SIGKILL laisse trace ») :
//   - trace commitée présente (crash d'un détenteur sans release, ou avant le
//     COMMIT du DELETE de release) ⇒ refus conservateur ;
//   - init incomplet (fichier vide ou schéma non commité/corrompu, journal
//     MEMORY) ⇒ état ambigu ⇒ refus conservateur, jamais de remplissage ;
//   - crash pendant `release` APRÈS le COMMIT du DELETE et avant la fermeture ⇒
//     état LIBRE légitime (la libération était engagée) ⇒ le détenteur suivant
//     acquiert ;
//   - crash pendant l'acquisition AVANT le COMMIT de la trace : le processus
//     n'est jamais entré dans la section protégée ; si le schéma est intact et
//     sans trace, l'état est libre ; s'il est ambigu, refus conservateur.
//
// Limites : aucune durabilité face à une panne matérielle ; mécanisme local (pas
// de multi-machine/NFS) ; un acteur qui SUPPRIME le fichier de verrou hors
// protocole casse l'exclusion (nouvel inode = second verrou possible) — chemin
// jamais emprunté par le protocole.
import fs from 'node:fs'
import Database from 'better-sqlite3'

const SCHEMA = `CREATE TABLE lock_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  at TEXT NOT NULL
)`
const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim().toLowerCase()

/** Valide le schéma exact en LECTURE seule : ni table étrangère ni trigger. */
function hasValidSchema (db) {
  try {
    const objects = db.prepare('SELECT type, name, sql FROM sqlite_master').all()
    return objects.length === 1 && objects[0].type === 'table' &&
      objects[0].name === 'lock_owner' && typeof objects[0].sql === 'string' &&
      normalizeSql(objects[0].sql) === normalizeSql(SCHEMA)
  } catch { return false }
}

/** 'absent' | 'file' | 'symlink' | 'notfile' | 'invalid' (lstat, sans suivre les liens). */
function pathKind (p) {
  let st
  try { st = fs.lstatSync(p) } catch (e) { return e.code === 'ENOENT' ? 'absent' : 'invalid' }
  if (st.isSymbolicLink()) return 'symlink'
  if (!st.isFile()) return 'notfile'
  return 'file'
}

export class CorpusLock {
  constructor (lockPath) {
    this.path = lockPath // chemin du fichier de verrou (base SQLite dédiée)
    this.db = null // connexion détenant le verrou noyau (null = non détenu)
  }

  acquire () {
    if (this.db != null) return true // déjà détenu par cette instance : idempotent
    const kind = pathKind(this.path)
    if (kind === 'invalid' || kind === 'symlink' || kind === 'notfile') return false

    // 1. Chemin absent : réservation EXCLUSIVE. Seul le créateur initialise.
    let fresh = false
    if (kind === 'absent') {
      let fd = null
      try { fd = fs.openSync(this.path, 'wx') } catch (e) { if (e.code !== 'EEXIST') return false }
      if (fd != null) { try { fs.closeSync(fd) } catch {}; fresh = true }
      // EEXIST : un concurrent a créé le fichier entre lstat et open → artefact
      // existant, validé (jamais initialisé) par ce processus.
    }

    // 2. Artefact existant : validation LECTURE SEULE, aucune mutation de structure.
    if (!fresh) {
      let ro = null
      try {
        ro = new Database(this.path, { readonly: true, fileMustExist: true })
        ro.pragma('busy_timeout = 0')
        const ok = hasValidSchema(ro)
        ro.close()
        if (!ok) return false
      } catch {
        try { if (ro) ro.close() } catch {}
        return false
      }
    }

    // 3. Verrou noyau + trace propriétaire. `CREATE TABLE` UNIQUEMENT si neuf.
    let db = null
    try {
      db = new Database(this.path)
      db.pragma('busy_timeout = 0')
      db.pragma('journal_mode = MEMORY') // pas de journal disque résiduel à interpréter
      db.pragma('locking_mode = EXCLUSIVE')
      db.exec('BEGIN EXCLUSIVE') // atomique : sinon SQLITE_BUSY → refus
      if (fresh) {
        db.exec(SCHEMA)
      } else if (!hasValidSchema(db)) {
        // L'artefact a changé entre la validation et le verrou : refus sans écrire.
        db.exec('ROLLBACK'); db.close(); return false
      }
      const stale = db.prepare('SELECT pid FROM lock_owner WHERE id = 1').get()
      if (stale) { // trace commitée d'un détenteur précédent → refus conservateur
        db.exec('ROLLBACK'); db.close(); return false
      }
      db.prepare('INSERT OR REPLACE INTO lock_owner (id, pid, at) VALUES (1, ?, ?)')
        .run(process.pid, new Date().toISOString())
      db.exec('COMMIT') // en locking_mode=EXCLUSIVE, la connexion garde le verrou noyau
      this.db = db
      return true
    } catch {
      // Échec d'init/COMMIT (ou toute erreur) : ROLLBACK + fermeture, aucune
      // connexion conservée ; l'artefact reste dans son état (ambigu si l'init
      // n'a pas abouti), ce qui provoque un refus conservateur à la prochaine passe.
      try {
        if (db) {
          try { db.exec('ROLLBACK') } catch {}
          db.close()
        }
      } catch {}
      this.db = null
      return false
    }
  }

  release () {
    if (this.db == null) return
    const db = this.db
    this.db = null
    // Ne retire QUE notre propre trace, sous le verrou noyau. Le COMMIT du DELETE
    // est la frontière : après lui, l'état est LIBRE même si le processus meurt
    // avant la fermeture. Le fichier de verrou n'est jamais supprimé.
    try { db.prepare('DELETE FROM lock_owner WHERE id = 1').run() } catch {}
    try { db.close() } catch {}
  }
}

/**
 * Validation forte d'un verrou DÉJÀ DÉTENU transmis à une opération archive
 * (recover/migrate → buildView, lot A2) : instance réelle de CorpusLock,
 * effectivement détenue (connexion ouverte) et liée au chemin du verrou du
 * corpus cible. Jamais un simple booléen `lock: true`, qui contournerait
 * l'exclusion mutuelle.
 */
export function assertHeldLock (lock, expectedPath) {
  if (!(lock instanceof CorpusLock)) {
    throw new Error('verrou transmis invalide : une instance de CorpusLock détenant le verrou est attendue — jamais un booléen ni un objet quelconque')
  }
  if (lock.db == null) {
    throw new Error('verrou transmis invalide : ce verrou n’est pas détenu — acquérir le verrou avant de le transmettre à l’opération')
  }
  if (lock.path !== expectedPath) {
    throw new Error(`verrou transmis invalide : le verrou détenu porte sur ${lock.path}, l’opération porte sur ${expectedPath}`)
  }
}
