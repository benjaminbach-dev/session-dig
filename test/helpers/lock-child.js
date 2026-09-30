// Helper ENFANT pour les tests multi-processus du verrou
// (test/lock-concurrency.test.js). Aucune API de test n'est ajoutée à la
// production : l'enfant n'importe que `CorpusLock` et le fs, et ne communique
// que par messages IPC. Les barrières de synchronisation SONT ces messages —
// aucun test ne repose sur un délai.
//
// Commandes reçues (`{ cmd }`) :
//   acquire  → tente l'acquisition ; répond 'acquired' ou 'refused' (ou 'error'
//              si l'acquisition lève après création — injection LOCK_FAIL_WRITE).
//              En cas de succès, écrit `BEGIN <pid>` dans le journal et GARDE le
//              verrou jusqu'à `release`.
//   release  → si détenu, écrit `END <pid>`, libère, répond 'released'. Avec
//              LOCK_DEFER_UNLINK=1, l'unlink est différé : répond
//              'unlink-deferred' (fichier encore présent) ; `finish-release`
//              exécute alors l'unlink et répond 'released'.
//   abandon  → sortie brutale SANS release (propriétaire mort ; test « mort
//              confirmé par la sortie réellement observée de l'enfant »).
//   exit     → sortie propre (0) sans toucher au verrou.
//
// Variables d'environnement :
//   LOCK_PATH         chemin du fichier de verrou (obligatoire)
//   LOCK_LOG          journal partagé des sections protégées (optionnel)
//   LOCK_FAIL_WRITE   '1' → remplace fs.writeSync pour échouer APRÈS la création
//                     du fichier (vérifie le nettoyage et l'absence de fd orphelin).
//   LOCK_DEFER_UNLINK '1' → suspend l'unlink de release jusqu'à `finish-release`
//                     (barrière IPC exacte autour de release, enfant uniquement).
import fs from 'node:fs'
import { CorpusLock } from '../../src/corpus.js'

const lockPath = process.env.LOCK_PATH
const logPath = process.env.LOCK_LOG || null

if (process.env.LOCK_FAIL_WRITE === '1') {
  fs.writeSync = () => {
    const e = new Error('injection : échec d’écriture après création du verrou')
    e.code = 'EIO'
    throw e
  }
}

const lock = new CorpusLock(lockPath)
const send = (type, extra = {}) => { if (process.send) process.send({ type, pid: process.pid, ...extra }) }
const append = (line) => { if (logPath) fs.appendFileSync(logPath, line + '\n') }

// Hook de test CIBLÉ (enfant uniquement, aucune API de production) : différer
// l'unlink de `release` juste AVANT son exécution, pour poser une barrière IPC
// exacte. Le fichier de verrou reste alors présent ; le parent peut tenter une
// acquisition (refus attendu) puis ordonner `finish-release` (unlink effectif).
// Aucune temporisation n'intervient dans cette synchronisation.
const origRmSync = fs.rmSync
let deferred = null
if (process.env.LOCK_DEFER_UNLINK === '1') {
  fs.rmSync = (p, opts) => {
    if (p === lockPath) { deferred = { p, opts }; return }
    return origRmSync(p, opts)
  }
}

let held = false

process.on('message', (msg) => {
  const cmd = msg && msg.cmd
  if (cmd === 'acquire') {
    try {
      if (lock.acquire()) {
        held = true
        append(`BEGIN ${process.pid}`)
        send('acquired')
      } else {
        send('refused')
      }
    } catch (e) {
      send('error', { message: e.message, code: e.code })
    }
    return
  }
  if (cmd === 'release') {
    if (held) { append(`END ${process.pid}`); held = false }
    deferred = null
    lock.release()
    if (deferred != null) send('unlink-deferred')
    else send('released')
    return
  }
  if (cmd === 'finish-release') {
    if (deferred != null) { const d = deferred; deferred = null; origRmSync(d.p, d.opts) }
    send('released')
    return
  }
  if (cmd === 'abandon') process.exit(7)
  if (cmd === 'exit') process.exit(0)
})

send('ready')
