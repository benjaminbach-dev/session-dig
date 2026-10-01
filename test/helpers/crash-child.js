// Helper ENFANT pour les interruptions RÉELLES du lot A3 (test/crash-real.test.js).
// L'enfant exécute une ingestion et se met en PAUSE à un point EXACT du protocole
// de publication : un hook fs (writeFileSync / renameSync / rmSync) ou un hook
// Database.prototype.exec — installé ENFANT UNIQUEMENT (aucune API de test dans la
// production), comme archive-child.js et lock-child.js. À l'appel intercepté :
// message IPC 'paused' PUIS blocage en lecture synchrone sur stdin (fd 0, EAGAIN
// retry, EOF → abandon explicite) ; le parent SIGKILL à la réception de 'paused',
// l'appel intercepté n'est JAMAIS exécuté — crash juste AVANT ce point.
// La barrière de synchronisation EST le message IPC : aucun délai n'intervient.
//
// Variables d'environnement :
//   CRASH_ROOT     racine du corpus (obligatoire)
//   CRASH_DB       base source opencode (obligatoire)
//   CRASH_PI       répertoire source pi (optionnel)
//   CRASH_FN       fonction fs à crocher (writeFileSync | renameSync | rmSync)
//   CRASH_MATCH    sous-chaîne du chemin déclenchant la pause
//   CRASH_SKIP     nombre d'appels correspondants laissés passer avant la pause
//                  (défaut 0 — pause au premier appel correspondant)
//   CRASH_DB_EXEC  sous-chaîne SQL déclenchant la pause avant exec (ex. COMMIT)
//
// Messages envoyés : 'ready' (hooks installés), 'paused' (au point de pause, avec
// le point exact), 'done' (résultat JSON), 'error'. Commandes reçues : 'run',
// 'exit'. Un seul point de pause par enfant (usage unique).
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { ingest } from '../../src/corpus.js'

const ROOT = process.env.CRASH_ROOT
const DB = process.env.CRASH_DB
const PI = process.env.CRASH_PI || undefined

const send = (type, extra = {}) => { if (process.send) process.send({ type, pid: process.pid, ...extra }) }

// ── Pause : bloquer sur stdin jusqu'à un octet du parent (ou abandon sur EOF —
// le parent a disparu : ne JAMAIS poursuivre l'opération sans la barrière) ; en
// cas de reprise explicite, l'appelant exécute ensuite l'appel intercepté. ──
let armed = true
const blockOnStdin = () => {
  const buf = Buffer.alloc(1)
  for (;;) {
    let n
    try { n = fs.readSync(0, buf, 0, 1, null) } catch (e) {
      if (e && e.code === 'EAGAIN') continue
      throw e
    }
    if (n > 0) return // octet du parent : reprise explicite
    // EOF (0) : stdin fermé — abandon immédiat et explicite au point de pause,
    // l'appel intercepté n'est pas exécuté (le marqueur déjà posé reste).
    throw new Error('pause de test : stdin fermé (EOF) sans octet du parent — abandon de l’opération au point de pause')
  }
}

const FN = process.env.CRASH_FN || null
const MATCH = process.env.CRASH_MATCH || null
const SKIP = Number(process.env.CRASH_SKIP ?? 0)

if (FN && MATCH) {
  const orig = fs[FN].bind(fs)
  let hits = 0
  fs[FN] = (...args) => {
    if (armed && args.some((a) => typeof a === 'string' && a.includes(MATCH))) {
      if (hits < SKIP) { hits++; return orig(...args) }
      armed = false // usage unique : pause à ce point seulement
      // Hygiène : consigner le premier arguMENT chemin tronqué — jamais le contenu
      // éventuel (data de writeFileSync) dans le diagnostic.
      const at = `${FN}(${String(args.find((a) => typeof a === 'string')).slice(0, 120)})`
      send('paused', { at })
      blockOnStdin()
    }
    return orig(...args)
  }
}

if (process.env.CRASH_DB_EXEC) {
  const MATCH_SQL = process.env.CRASH_DB_EXEC
  const origExec = Database.prototype.exec
  Database.prototype.exec = function (sql, ...rest) {
    // Ne pas armer la pause sur le COMMIT du FICHIER DE VERROU (lot A1, base SQLite
    // dédiée `.ingest-lock`) : seul le COMMIT de publication de la vue importe ici.
    const isLockDb = typeof this.name === 'string' && this.name.endsWith('.ingest-lock')
    if (!isLockDb && armed && typeof sql === 'string' && sql.includes(MATCH_SQL)) {
      armed = false // usage unique : pause à ce point seulement
      send('paused', { at: `Database.exec(${sql.trim().slice(0, 60)})` })
      blockOnStdin()
    }
    return origExec.call(this, sql, ...rest)
  }
}

process.on('message', (msg) => {
  const cmd = msg && msg.cmd
  if (cmd === 'run') {
    Promise.resolve()
      .then(() => ingest({ root: ROOT, db: DB, ...(PI ? { piDir: PI } : {}) }))
      .then((result) => send('done', { result }))
      .catch((e) => send('error', { message: e.message, code: e && e.code }))
    return
  }
  if (cmd === 'exit') process.exit(0)
})

send('ready')
