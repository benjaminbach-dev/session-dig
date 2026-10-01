// Helper ENFANT pour les tests multiprocessus du lot A2 (protection par verrou de
// TOUTE l'opération d'archive : buildView/index, fingerprint, migrate v1 et chemin
// déjà v2, recover, ingest). Aucune API de test dans la production : l'enfant
// installe lui-même un hook fs ciblé (pause à un point précis APRÈS le contrôle
// initial, au sein même de l'opération), signale 'paused' par IPC puis se bloque
// en lecture synchrone sur stdin (fd 0) jusqu'à l'octet envoyé par le parent.
// Les barrières SONT les messages IPC — aucun test ne repose sur un délai.
//
// Variables d'environnement :
//   ARCHIVE_ROOT        racine du corpus (obligatoire)
//   ARCHIVE_DB          base source opencode (pour ARCHIVE_OP=ingest)
//   ARCHIVE_OP          buildview | bm25index | fingerprint | migrate | recover | ingest
//   ARCHIVE_PAUSE_FN    nom de la fonction fs à crocher (rmSync, writeFileSync,
//                       readdirSync, renameSync) — optionnel
//   ARCHIVE_PAUSE_MATCH sous-chaîne du chemin déclenchant la pause (au premier appel
//                       correspondant uniquement — hook à usage unique)
//
// Messages IPC envoyés : 'ready' (hooks installés), 'paused' (au point de pause),
// 'done' (résultat JSON de l'opération), 'error' (message/code). Commandes
// reçues : 'run' (exécute l'opération), 'exit' (sortie propre).
import fs from 'node:fs'
import { ingest, migrate, recover, fingerprint } from '../../src/corpus.js'
import { buildView } from '../../src/view.js'
import { index as bm25Index } from '../../src/retriever/bm25.js'

const ROOT = process.env.ARCHIVE_ROOT
const DB = process.env.ARCHIVE_DB || null
const OP = process.env.ARCHIVE_OP

const send = (type, extra = {}) => { if (process.send) process.send({ type, pid: process.pid, ...extra }) }

// ── Pause : hook fs ENFANT UNIQUEMENT (jamais d'API de production test) ──
// À la PREMIÈRE invocation dont un argument de type chemin contient MATCH :
// envoyer 'paused' PUIS bloquer en lecture sur stdin (fd 0) jusqu'à l'octet du
// parent. Le message IPC est petit (pipe tamponné) : la livraison au parent ne
// dépend pas de la boucle d'événements bloquée ensuite.
const PAUSE_FN = process.env.ARCHIVE_PAUSE_FN || null
const PAUSE_MATCH = process.env.ARCHIVE_PAUSE_MATCH || null

if (PAUSE_FN && PAUSE_MATCH) {
  const orig = fs[PAUSE_FN].bind(fs)
  let fired = false
  fs[PAUSE_FN] = (...args) => {
    if (!fired && args.some((a) => typeof a === 'string' && a.includes(PAUSE_MATCH))) {
      fired = true
      send('paused')
      const buf = Buffer.alloc(1)
      for (;;) {
        let n
        try { n = fs.readSync(0, buf, 0, 1, null) } catch (e) {
          if (e && e.code === 'EAGAIN') continue
          throw e
        }
        if (n > 0) break // octet du parent : reprise explicite
        // EOF (0) : stdin fermé — le parent a disparu. Abandon immédiat et
        // explicite au point de pause : NE JAMAIS poursuivre l'opération sans
        // la barrière convenue (pas de poursuite après mort/fermeture du parent).
        throw new Error('pause de test : stdin fermé (EOF) sans octet du parent — abandon de l’opération au point de pause')
      }
    }
    return orig(...args)
  }
}

function runOp () {
  switch (OP) {
    case 'buildview': return buildView(ROOT)
    case 'bm25index': return bm25Index(ROOT)
    case 'fingerprint': return fingerprint(ROOT)
    case 'migrate': return migrate(ROOT)
    case 'recover': return recover(ROOT)
    case 'ingest': return ingest({ root: ROOT, db: DB })
    default: throw new Error(`opération inconnue : ${OP}`)
  }
}

process.on('message', (msg) => {
  const cmd = msg && msg.cmd
  if (cmd === 'run') {
    Promise.resolve()
      .then(runOp)
      .then((result) => send('done', { result }))
      .catch((e) => send('error', { message: e.message, code: e && e.code }))
    return
  }
  if (cmd === 'exit') process.exit(0)
})

send('ready')
