// Verrou consultatif de corpus (extrait de corpus.js — lot A2) : module partagé
// sans cycle, importé par corpus.js (réexport pour compat) et view.js
// (buildView). N'importe que `fs` — aucune dépendance de production.
//
// ── Verrou consultatif contre ingestions concurrentes (passe corrective 20/09, revue).
// Création exclusive (`wx` = O_CREAT|O_EXCL) : l'acquisition est atomique. La reprise
// AUTOMATIQUE d'un verrou périmé a été RETIRÉE (revue A1) : lire le PID puis retirer
// le fichier n'est pas atomique vis-à-vis des autres repreneurs — un repreneur pouvait
// supprimer le verrou tout neuf d'un propriétaire vivant. Un verrou ambigu (périmé ou
// non) est donc REFUSÉ conservativement. Le retrait manuel éventuel n'est légitime
// qu'après arrêt coordonné de TOUS les utilisateurs du corpus — jamais sous concurrence.
// Ce mécanisme n'est PAS un flock : toutes ses garanties sont un effort COOPÉRATIF
// (best effort), sans atomicité face à un retrait externe du fichier ; le recyclage de
// PID reste un risque résiduel, documenté, jamais présenté comme sûr.
import fs from 'node:fs'

export class CorpusLock {
  constructor (lockPath) { this.path = lockPath; this.fd = null }
  acquire () {
    if (this.fd != null) return true // best effort : déjà détenu par cette instance (un retrait externe peut avoir orphelinisé le fd ; aucune atomicité n'est promise)
    let fd
    try {
      fd = fs.openSync(this.path, 'wx') // atomique : un seul créateur possible
    } catch {
      // EEXIST (verrou pris, vide, illisible, ou répertoire) ou toute autre erreur
      // d'ouverture : refus conservateur, sans jamais toucher au fichier d'autrui.
      this.fd = null
      return false
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n')
    } catch (e) {
      // Échec APRÈS création : nettoyage best effort. À cet instant nous étions le
      // créateur exclusif, mais la fermeture puis le retrait ne sont pas atomiques
      // face à un retrait externe + réacquisition : cette voie suppose des acteurs
      // coopératifs. On propage l'erreur sans laisser de descripteur ni de fichier.
      try { fs.closeSync(fd) } catch {}
      try { fs.rmSync(this.path, { force: true }) } catch {}
      this.fd = null
      throw e
    }
    this.fd = fd
    return true
  }
  release () {
    if (this.fd == null) return
    // Best effort coopératif : ne retirer le fichier que s'il est encore le nôtre
    // ((dev, ino) comparés au descripteur). Ce n'est PAS atomique : entre le stat et
    // le rm, un retrait externe suivi d'une réacquisition par un acteur non
    // coopératif peut encore se glisser. Aucune garantie absolue n'est promise.
    let own = false
    try {
      const fdStat = fs.fstatSync(this.fd)
      const pathStat = fs.statSync(this.path)
      own = fdStat.dev === pathStat.dev && fdStat.ino === pathStat.ino
    } catch { own = false }
    try { fs.closeSync(this.fd) } catch {}
    this.fd = null
    if (own) { try { fs.rmSync(this.path, { force: true }) } catch {} }
  }
}

/**
 * Validation forte d'un verrou DÉJÀ DÉTENU transmis à une opération archive
 * (recover/migrate → buildView, lot A2) : instance réelle de CorpusLock,
 * effectivement détenue par cette instance (descripteur ouvert) et liée au
 * chemin du verrou du corpus cible. Jamais un simple booléen `lock: true`,
 * qui contournerait l'exclusion mutuelle.
 */
export function assertHeldLock (lock, expectedPath) {
  if (!(lock instanceof CorpusLock)) {
    throw new Error('verrou transmis invalide : une instance de CorpusLock détenant le verrou est attendue — jamais un booléen ni un objet quelconque')
  }
  if (lock.fd == null) {
    throw new Error('verrou transmis invalide : ce verrou n’est pas détenu — acquérir le verrou avant de le transmettre à l’opération')
  }
  if (lock.path !== expectedPath) {
    throw new Error(`verrou transmis invalide : le verrou détenu porte sur ${lock.path}, l’opération porte sur ${expectedPath}`)
  }
}
