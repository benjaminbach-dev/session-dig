// Admission mono-travail server-global (lot M1b).
//
// Un seul appel d'outil actif à la fois, sans file d'attente applicative :
// `tryAcquire()` échoue si le créneau est occupé au moment où le gestionnaire
// admet l'appel (→ `busy`). Aucune réactivité immédiate n'est garantie pendant un
// calcul synchrone : une requête reçue pendant ce calcul peut n'être admise
// qu'après sa fin (design D6). Le créneau est conservé jusqu'à la fin du handler,
// indépendamment de la déconnexion du client, et n'est jamais libéré par un faux
// timeout. `waitIdle()` sert uniquement à l'arrêt normal (aucune file de travail).
export class AdmissionGate {
  #active = false
  #idleWaiters = []

  get active () {
    return this.#active
  }

  /** Tente de prendre le créneau ; false s'il est déjà occupé (pas de file). */
  tryAcquire () {
    if (this.#active) return false
    this.#active = true
    return true
  }

  release () {
    if (!this.#active) return
    this.#active = false
    for (const resolve of this.#idleWaiters.splice(0)) resolve()
  }

  /** Résout quand aucun travail n'est actif (arrêt normal). */
  waitIdle () {
    if (!this.#active) return Promise.resolve()
    return new Promise((resolve) => { this.#idleWaiters.push(resolve) })
  }
}