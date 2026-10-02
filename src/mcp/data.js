// Accès lecture seule à la vue publiée, snapshot cohérent et contrôle de
// fraîcheur par source (lot data M1). Module SANS handler métier, sans CLI, sans
// réparation : il ouvre la vue en lecture seule, vérifie schéma/layout/watermarks
// DANS le snapshot de lecture, exécute un callback SYNCHRONE dans ce même
// snapshot, et refuse (`view_unavailable`) si une publication ou un remplacement
// est détecté avant le rendu des données.
//
// Réutilisation : la décision de fraîcheur vient de `checkFresh` (logique commune
// `src/view.js`), alimentée par UN état publié capturé de façon stable. L'identité
// de LECTURE est la génération PUBLIÉE (`meta.generation`, jeton aléatoire renouvelé
// par les producteurs CLI) liée aux watermarks par source (hash stable), lue dans le
// snapshot et recontrôlée après COMMIT ; `PRAGMA data_version` détecte en plus un
// COMMIT concurrent, et les statistiques de fichier un remplacement. `indexMtime`
// reste un diagnostic, jamais une identité de génération. Une vue ancienne sans
// génération rend `generation: null` (compatible) : le curseur read (M3b) refusera
// de s'appuyer dessus et exigera une reconstruction CLI manuelle (`sdig refresh`).
//
// Le callback est du code interne de confiance, JAMAIS une entrée d'agent ni un
// bac à sable : il reçoit une façade LECTURE SEULE (pas d'`exec`/`pragma`/`attach`,
// statements `reader` seulement) sur une connexion SQLite `readonly` + `query_only`.
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { corpusPaths } from '../paths.js'
import { viewPath, viewHasSchema, watermarkHasSourceColumn, sourceStatesOf, checkFresh, readViewIdentity, identityHash } from '../view.js'
import { LAYOUT_VERSION } from '../layout.js'
import { isMcpAppError, viewUnavailable, internalError } from './errors.js'

// Code de fraîcheur (ensemble fermé de view.checkFresh) → raison publique fermée.
const FRESH_REASON = Object.freeze({
  invalid_schema: 'invalid_schema',
  missing_state: 'missing_state',
  view_ahead: 'pi_divergence',
  stale_view: 'stale_view',
  pi_divergence: 'pi_divergence'
})

const KNOWN_SOURCES = new Set(['opencode', 'pi'])
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function statIdentity (p) {
  try {
    const s = fs.statSync(p)
    return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** Même fichier (identité), pas seulement mêmes octets. */
function sameFile (a, b) {
  return a != null && b != null && a.dev === b.dev && a.ino === b.ino
}

/** Même fichier et même contenu apparent (taille/mtime). */
function sameStat (a, b) {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/**
 * Configuration des sources (propriétaire) : seuls `opencode` et `pi` sont
 * reconnus, chacun `{ path: string }`. Les noms inconnus sont ignorés (jamais
 * renvoyés ni recopiés) ; une forme invalide refuse le démarrage de la lecture.
 */
function validateSourcesConfig (sourcesConfig) {
  if (sourcesConfig == null) return
  if (!isPlainObject(sourcesConfig)) throw internalError('invalid_config')
  for (const name of Object.keys(sourcesConfig)) {
    if (!KNOWN_SOURCES.has(name)) continue
    const cfg = sourcesConfig[name]
    if (!isPlainObject(cfg) || typeof cfg.path !== 'string' || !cfg.path) throw internalError('invalid_config')
  }
}

/** Callback purement synchrone : les formes async/generator sont refusées AVANT appel. */
function assertSyncCallback (callback) {
  if (typeof callback !== 'function') throw internalError('invalid_config')
  const name = callback.constructor ? callback.constructor.name : ''
  if (name === 'AsyncFunction' || name === 'AsyncGeneratorFunction') throw internalError('async_callback')
  if (name === 'GeneratorFunction') throw internalError('unsupported_callback')
}

/**
 * Forme d'état acceptée par MCP : objet non-tableau, `layoutVersion` numérique
 * exacte. La forme PLATE héritée (`message`/`session` au niveau racine, sans
 * `sources`) reste acceptée ; si `sources` est présent, c'est un objet, chaque
 * source un objet, et `pi.files` — s'il est présent — un objet non-tableau.
 * Aucune donnée n'est inventée pour une structure incompatible.
 */
function assertStateShape (st) {
  if (!isPlainObject(st)) throw viewUnavailable('invalid_schema')
  if (typeof st.layoutVersion !== 'number' || st.layoutVersion !== LAYOUT_VERSION) throw viewUnavailable('invalid_schema')
  if (st.sources === undefined) return
  if (!isPlainObject(st.sources)) throw viewUnavailable('invalid_schema')
  for (const name of Object.keys(st.sources)) {
    if (!isPlainObject(st.sources[name])) throw viewUnavailable('invalid_schema')
    if (name === 'pi' && st.sources.pi.files !== undefined && !isPlainObject(st.sources.pi.files)) {
      throw viewUnavailable('invalid_schema')
    }
  }
}

/**
 * Capture UN état publié stable : stat avant ET après la lecture du contenu,
 * contenu identique (inode/taille/mtime) et forme stricte. Une republication
 * pendant la lecture est réessayée puis refusée — le même objet sert ensuite à
 * `checkFresh` et aux projections.
 */
function capturePublishedState (statePath, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const before = statIdentity(statePath)
    if (before == null) throw viewUnavailable('missing_state')
    let raw
    try {
      raw = fs.readFileSync(statePath, 'utf8')
    } catch (e) {
      throw viewUnavailable(e && e.code === 'ENOENT' ? 'missing_state' : 'invalid_schema')
    }
    const after = statIdentity(statePath)
    if (!sameStat(before, after)) continue // republié pendant la lecture → réessayer
    let st
    try { st = JSON.parse(raw) } catch { throw viewUnavailable('invalid_schema') }
    assertStateShape(st)
    return { state: st, identity: after }
  }
  throw viewUnavailable('changed_publication')
}

/** Projection canonique (noms triés) pour détecter un changement d'état publié. */
function projectSources (state) {
  const out = {}
  const sources = sourceStatesOf(state)
  for (const name of Object.keys(sources).sort()) {
    const s = sources[name]
    out[name] = name === 'pi'
      ? { token: s.token ?? null, files: Object.keys(s.files && typeof s.files === 'object' ? s.files : {}).sort() }
      : { token: s.token ?? null, message: s.message ?? null, session: s.session ?? null }
  }
  return out
}

/** Objet brut `state.sources.pi.files` (propre, objet non-tableau) ou `null` si absent. */
function rawPiFiles (state) {
  if (!isPlainObject(state) || !isPlainObject(state.sources)) return null
  const pi = state.sources.pi
  if (!isPlainObject(pi) || pi.files === undefined) return null
  return isPlainObject(pi.files) ? pi.files : null
}

/**
 * Fraîcheur exposable : watermarks PUBLIÉS par source, horodatage de l'index
 * (diagnostic) et version de schéma. Aucun chemin, aucun nom de fichier suivi.
 * Le sentinel `-1` (indisponible) devient `null` ; un nombre de fichiers pi n'est
 * exposé que si l'état publié porte réellement un objet `files` (sinon `null`).
 */
function buildFreshness (watermark, state, vp) {
  const piFiles = rawPiFiles(state)
  const sources = {}
  for (const [name, row] of Object.entries(watermark)) {
    if (name === 'opencode') {
      sources.opencode = {
        message: Number.isFinite(row.message) && row.message > -1 ? row.message : null,
        session: Number.isFinite(row.session) && row.session > -1 ? row.session : null
      }
    } else if (name === 'pi') {
      sources.pi = { token: row.token ?? null, files: piFiles ? Object.keys(piFiles).length : null }
    } else {
      sources[name] = { token: row.token ?? null }
    }
  }
  let indexMtime = null
  try { indexMtime = fs.statSync(vp).mtimeMs } catch { /* diagnostic indisponible */ }
  return { sources, indexMtime, corpusVersion: LAYOUT_VERSION }
}

/**
 * Disponibilité ACTUELLE des sources configurées : `stat` seulement (jamais le
 * contenu). `opencode` attend un FICHIER, `pi` un RÉPERTOIRE ; un type inversé est
 * indisponible, une erreur d'accès autre que l'absence est `null` (inconnue).
 */
function availabilityOf (sourcesConfig) {
  const out = {}
  if (sourcesConfig == null) return out
  for (const name of Object.keys(sourcesConfig)) {
    if (!KNOWN_SOURCES.has(name)) continue
    const path = sourcesConfig[name].path
    try {
      const s = fs.statSync(path)
      out[name] = name === 'pi' ? s.isDirectory() : s.isFile()
    } catch (e) {
      out[name] = e && e.code === 'ENOENT' ? false : null
    }
  }
  return out
}

/** Façade lecture seule : pas d'`exec`/`pragma`/`attach`, statements `reader` only. */
function readOnlyFacade (db) {
  const wrap = (stmt) => {
    if (stmt.reader !== true) throw new Error('statement non lecture refusé')
    return Object.freeze({
      get: (...p) => stmt.get(...p),
      all: (...p) => stmt.all(...p),
      iterate: (...p) => stmt.iterate(...p)
    })
  }
  const prepare = (sql) => wrap(db.prepare(sql))
  return Object.freeze({
    prepare,
    get: (sql, ...p) => prepare(sql).get(...p),
    all: (sql, ...p) => prepare(sql).all(...p),
    iterate: (sql, ...p) => prepare(sql).iterate(...p)
  })
}

/**
 * Contrôle de publication : identité de l'index avant ET après la capture de
 * l'état final (un remplacement pendant cette capture est ainsi détecté), état
 * stable identique (fichier + projection). Lève `changed_publication` sinon.
 */
function checkPublication ({ vp, viewIdBefore, statePath, stateId0, projection0 }) {
  if (!sameFile(viewIdBefore, statIdentity(vp))) throw viewUnavailable('changed_publication')
  let published
  try { published = capturePublishedState(statePath) } catch { throw viewUnavailable('changed_publication') }
  if (!sameStat(stateId0, published.identity)) throw viewUnavailable('changed_publication')
  if (JSON.stringify(projectSources(published.state)) !== projection0) throw viewUnavailable('changed_publication')
  if (!sameFile(viewIdBefore, statIdentity(vp))) throw viewUnavailable('changed_publication')
}

/**
 * Exécute `callback({ view, freshness, availability })` dans UN snapshot cohérent
 * de la vue publiée. Le callback DOIT être synchrone ; un `Promise` renvoyé est
 * refusé sans être attendu (un rejet de Promise NATIVE est neutralisé par un catch
 * vide, sans prétendre annuler son travail). Toute exception non applicative
 * devient `internal` bornée.
 *
 * @returns {{ data: any, freshness: object, availability: object }}
 */
export function openReadSnapshot (config, callback) {
  assertSyncCallback(callback)
  const root = config && typeof config.root === 'string' && config.root ? config.root : null
  if (!root) throw internalError('invalid_config')
  validateSourcesConfig(config.sources)
  const vp = viewPath(root)
  const statePath = corpusPaths(root).state

  // Identité de l'index AVANT toute ouverture : un remplacement survenu pendant
  // l'établissement du snapshot ne doit pas associer un ancien fd à un nouvel inode.
  const viewIdBefore = statIdentity(vp)
  if (viewIdBefore == null) throw viewUnavailable('missing_view')

  let db
  try {
    db = new Database(vp, { readonly: true, fileMustExist: true })
    db.pragma('query_only = true')
  } catch {
    try { if (db) db.close() } catch { /* fermeture best-effort */ }
    throw viewUnavailable('invalid_schema')
  }

  try {
    // `data_version` lu HORS transaction : il ne change, pendant une transaction
    // de lecture ouverte (isolation de snapshot), qu'après son COMMIT ; un COMMIT
    // concurrent se détecte donc en le relisant après le COMMIT.
    let dataVersion0
    try { dataVersion0 = db.pragma('data_version', { simple: true }) } catch { throw viewUnavailable('invalid_schema') }
    try { db.exec('BEGIN') } catch { throw viewUnavailable('invalid_schema') }

    // Schéma/layout/watermarks vérifiés DANS le snapshot de lecture (mêmes données
    // que le callback), jamais dans une transaction antérieure séparée.
    try {
      if (!viewHasSchema(db) || !watermarkHasSourceColumn(db)) throw viewUnavailable('invalid_schema')
      const layout = db.prepare('SELECT value FROM meta WHERE key = ?').get('layoutVersion')
      if (!layout || Number(layout.value) !== LAYOUT_VERSION) throw viewUnavailable('invalid_schema')
    } catch (err) {
      if (isMcpAppError(err)) throw err
      throw viewUnavailable('invalid_schema') // fichier non SQLite, base tronquée, etc.
    }

    // Identité de génération publiée + watermarks par source, lus DANS le même
    // snapshot que les données. `generation` vaut `null` pour une vue ancienne
    // (compatible) ; elle n'est PAS présentée via `indexMtime`.
    const identity0 = readViewIdentity(db)
    const readIdentity = identityHash(identity0)
    const generation = identity0.generation

    // UN état publié stable, capturé une seule fois et réutilisé partout.
    const published = capturePublishedState(statePath)
    const projection0 = JSON.stringify(projectSources(published.state))
    const stateId0 = published.identity

    // Fraîcheur sur CE snapshot, contre l'état publié capturé (même objet).
    const fresh = checkFresh(root, { db, state: published.state })
    if (!fresh.fresh) throw viewUnavailable(FRESH_REASON[fresh.code] || 'stale_view')
    // Snapshot établi : l'index n'a pas été remplacé pendant son établissement.
    if (!sameFile(viewIdBefore, statIdentity(vp))) throw viewUnavailable('changed_publication')

    const freshness = buildFreshness(fresh.watermark, published.state, vp)
    const availability = availabilityOf(config.sources)
    const view = readOnlyFacade(db)

    const data = callback({ view, freshness, availability, generation, readIdentity })
    if (data instanceof Promise) {
      data.catch(() => {}) // évite unhandledRejection ; ne l'attend pas, ne l'annule pas
      throw internalError('async_callback')
    }
    if (data != null && typeof data.then === 'function') throw internalError('async_callback')

    // Contrôle AVANT COMMIT/rendu.
    checkPublication({ vp, viewIdBefore, statePath, stateId0, projection0 })

    db.exec('COMMIT')
    // COMMIT concurrent d'une AUTRE connexion pendant notre lecture.
    if (db.pragma('data_version', { simple: true }) !== dataVersion0) throw viewUnavailable('changed_publication')
    // L'identité de LECTURE (génération publiée + watermarks par source) est
    // recontrôlée après le COMMIT : un changement de génération ou de watermark
    // pendant la lecture invalide la page au lieu de mélanger deux états.
    if (identityHash(readViewIdentity(db)) !== readIdentity) throw viewUnavailable('changed_publication')
    // Recontrôle APRÈS COMMIT/data_version : un remplacement d'index ou une
    // republication survenus pendant la capture finale ou le COMMIT sont détectés
    // (l'ancien descripteur ne voit pas un nouveau fichier).
    checkPublication({ vp, viewIdBefore, statePath, stateId0, projection0 })

    return { data, freshness, availability, generation, readIdentity }
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* pas de transaction ou déjà terminée */ }
    throw isMcpAppError(err) ? err : internalError('callback_failed')
  } finally {
    try { db.close() } catch { /* fermeture best-effort */ }
  }
}