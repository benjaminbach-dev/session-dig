// Helper ENFANT pour les tests multi-processus du verrou
// (test/lock-concurrency.test.js, lot A1). Aucune API de test n'est ajoutée à la
// production : l'enfant n'importe que `CorpusLock` et le driver SQLite, et ne
// communique que par messages IPC. Les barrières de synchronisation SONT ces
// messages (lecture bloquante d'un octet sur stdin) — aucun délai.
//
// Le verrou est un VERROU NOYAU porté par une connexion SQLite sur un fichier qui
// n'est jamais supprimé (voir src/lock.js).
//
// Commandes (`{ cmd }`) :
//   acquire  → 'acquired' | 'refused' (avec `held`) | 'error'.
//   release  → 'released'. Avec LOCK_DEFER_RELEASE=1, pause AVANT la libération
//              (verrou noyau encore tenu, trace encore présente) : envoie
//              'before-release' ; `resume` (octet sur stdin) poursuit. Avec
//              LOCK_PAUSE_CLOSE=1, pause APRÈS le COMMIT du DELETE de trace et
//              AVANT la fermeture : 'after-delete-before-close' (verrou tenu,
//              trace effacée) ; `resume` termine.
//   abandon  → sortie brutale sans release (propriétaire mort).
//   exit     → sortie propre (0).
//
// Variables :
//   LOCK_PATH           chemin du fichier de verrou (obligatoire)
//   LOCK_LOG            journal partagé des sections protégées (optionnel)
//   LOCK_DEFER_RELEASE  '1' → barrière IPC avant la libération
//   LOCK_PAUSE_CLOSE    '1' → barrière IPC après DELETE, avant close (release)
//   LOCK_PAUSE_CREATE   '1' → pause après réservation wx, avant initialisation
//   LOCK_FAIL_INIT      '1' → `CREATE TABLE` (init) échoue
//   LOCK_FAIL_COMMIT    '1' → `COMMIT` de la trace échoue
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { CorpusLock } from '../../src/corpus.js'

const lockPath = process.env.LOCK_PATH
const logPath = process.env.LOCK_LOG || null

const send = (type, extra = {}) => { if (process.send) process.send({ type, pid: process.pid, ...extra }) }
const append = (line) => { if (logPath) fs.appendFileSync(logPath, line + '\n') }
const blockUntilResume = () => { const b = Buffer.alloc(1); fs.readSync(0, b, 0, 1, null) }

// Injections de test CIBLÉES (enfant uniquement).
if (process.env.LOCK_PAUSE_CREATE === '1') {
  const origOpen = fs.openSync
  fs.openSync = function (file, flags, ...rest) {
    const fd = origOpen.call(this, file, flags, ...rest)
    if (file === lockPath && flags === 'wx') {
      send('reserved-before-init')
      blockUntilResume()
    }
    return fd
  }
}
if (process.env.LOCK_FAIL_INIT === '1') {
  const origExec = Database.prototype.exec
  Database.prototype.exec = function (sql, ...rest) {
    if (typeof sql === 'string' && sql.includes('CREATE TABLE')) {
      const e = new Error('injection : échec de CREATE TABLE'); e.code = 'EIO'; throw e
    }
    return origExec.call(this, sql, ...rest)
  }
}
if (process.env.LOCK_FAIL_COMMIT === '1') {
  const origExec = Database.prototype.exec
  Database.prototype.exec = function (sql, ...rest) {
    if (typeof sql === 'string' && sql.trim() === 'COMMIT') {
      const e = new Error('injection : échec de COMMIT'); e.code = 'EIO'; throw e
    }
    return origExec.call(this, sql, ...rest)
  }
}
const origClose = Database.prototype.close
let pauseBeforeClose = false
Database.prototype.close = function (...args) {
  if (pauseBeforeClose) { pauseBeforeClose = false; send('after-delete-before-close'); blockUntilResume() }
  return origClose.apply(this, args)
}

const lock = new CorpusLock(lockPath)
let held = false

process.on('message', (msg) => {
  const cmd = msg && msg.cmd
  if (cmd === 'acquire') {
    try {
      const ok = lock.acquire()
      held = ok
      if (ok) append(`BEGIN ${process.pid}`)
      send(ok ? 'acquired' : 'refused', { held: lock.db != null })
    } catch (e) {
      send('error', { message: e.message, code: e.code, held: lock.db != null })
    }
    return
  }
  if (cmd === 'release') {
    if (!held) { send('released'); return }
    append(`END ${process.pid}`)
    held = false
    if (process.env.LOCK_DEFER_RELEASE === '1') { send('before-release'); blockUntilResume() }
    if (process.env.LOCK_PAUSE_CLOSE === '1') pauseBeforeClose = true
    lock.release()
    send('released')
    return
  }
  if (cmd === 'abandon') process.exit(7)
  if (cmd === 'exit') process.exit(0)
})

send('ready')
