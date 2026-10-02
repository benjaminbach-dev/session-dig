// Handler MÉTIER `sdig_status` (sous-lot status, M3 partiel).
//
// État en LECTURE SEULE du corpus local, sans AUCUN chemin rendu : compteurs
// globaux exacts connus, disponibilité de chaque source configurée, présence d'un
// état ingéré, watermark publié par source et compteurs par source quand ils sont
// connus (sinon `null`, jamais estimés). Aucune ingestion, réparation, indexation
// ni scan de contenu : l'accès passe exclusivement par `openReadSnapshot`
// (`src/mcp/data.js`), qui fournit un snapshot cohérent de la vue, la fraîcheur
// par source (logique commune `checkFresh`) et la disponibilité par `stat`.
//
// Décisions de ce lot (documentées) :
//  - La fraîcheur n'est PAS recalculée : `freshness` est l'objet construit par
//    `data.js`, repris tel quel dans la sortie.
//  - `rawFiles` est le compteur CONNU DE LA VUE (`rawrefs`), sans parcours
//    arbitraire du répertoire `raw/` ; si ce compteur n'est pas disponible, la
//    valeur est `null` (contrat élargi) plutôt qu'une estimation à 0.
//  - `available` vaut `true`/`false`/`null` : `null` = accès non déterminable
//    (ex. permission refusée), jamais converti en `false` inventé.
//  - Vue absente/périmée : l'appel échoue en `view_unavailable` avec une raison
//    FERMÉE (aucun chemin, aucun contenu). `view`/`viewNote` restent dans le
//    contrat pour un usage ultérieur ; sur un succès, `view` est renseigné et
//    `viewNote` vaut `null`.
import { openReadSnapshot } from './data.js'
import { viewUnavailable } from './errors.js'

// Sources connues du contrat (design D2). Un nom inconnu n'est jamais rendu.
const KNOWN_SOURCES = Object.freeze(['opencode', 'pi'])
const KNOWN = new Set(KNOWN_SOURCES)

/** Compteur global EXIGÉ (schéma entier non nul) : vue illisible = invalid_schema. */
function countRequired (view, sql) {
  try {
    const row = view.get(sql)
    if (!row || !Number.isInteger(row.n) || row.n < 0) throw new Error('compteur invalide')
    return row.n
  } catch {
    throw viewUnavailable('invalid_schema')
  }
}

/** Compteur de la vue NON EXIGÉ : indisponible => `null`, jamais estimé. */
function countOrNull (view, sql) {
  try {
    const row = view.get(sql)
    return row && Number.isInteger(row.n) && row.n >= 0 ? row.n : null
  } catch {
    return null
  }
}

/** Agrégat par source NON EXIGÉ : indisponible => `null` (comptes par source inconnus). */
function groupCountsOrNull (view, sql) {
  try {
    const out = new Map()
    for (const row of view.all(sql)) {
      if (typeof row.src === 'string' && Number.isInteger(row.n) && row.n >= 0) out.set(row.src, row.n)
    }
    return out
  } catch {
    return null
  }
}

/**
 * Construit la sortie `sdig_status` DANS le snapshot fourni par `openReadSnapshot`.
 * Aucune donnée n'est inventée : un champ indisponible est `null` selon le contrat.
 */
function buildStatus ({ view, freshness, availability, configured }) {
  const counts = {
    sessions: countRequired(view, 'SELECT COUNT(*) AS n FROM sessions'),
    // Les lignes de titre synthétiques sont exclues des compteurs d'événements (parité CLI).
    events: countRequired(view, "SELECT COUNT(*) AS n FROM events WHERE role != 'title'")
  }
  const rawFiles = countOrNull(view, 'SELECT COUNT(*) AS n FROM rawrefs')
  // Comptes par source : source portée par le champ `source` du JSON, défaut opencode.
  const sessionsBySource = groupCountsOrNull(view, "SELECT COALESCE(json_extract(json, '$.source'), 'opencode') AS src, COUNT(*) AS n FROM sessions GROUP BY src")
  const eventsBySource = groupCountsOrNull(view, "SELECT COALESCE(json_extract(json, '$.source'), 'opencode') AS src, COUNT(*) AS n FROM events WHERE role != 'title' GROUP BY src")

  // Sources rapportées : configurées (ensemble fermé) + réellement ingérées (watermark
  // publié), pour signaler une source archivée devenue absente sans effacer son état.
  const reported = new Set()
  for (const name of Object.keys(configured)) if (KNOWN.has(name)) reported.add(name)
  for (const name of Object.keys(freshness.sources)) if (KNOWN.has(name)) reported.add(name)

  const sources = {}
  for (const name of [...reported].sort()) {
    const ingested = Object.hasOwn(freshness.sources, name)
    const available = Object.hasOwn(availability, name) ? availability[name] : null
    const countsKnown = ingested && sessionsBySource != null && eventsBySource != null
    sources[name] = {
      available,
      ingested,
      watermark: ingested ? freshness.sources[name] : null,
      counts: countsKnown
        ? { sessions: sessionsBySource.get(name) ?? 0, events: eventsBySource.get(name) ?? 0 }
        : { sessions: null, events: null }
    }
  }

  const mtime = freshness.indexMtime
  const viewOut = Number.isFinite(mtime) ? { events: counts.events, mtime } : null
  return {
    counts,
    rawFiles,
    view: viewOut,
    viewNote: viewOut ? null : 'horodatage de vue indisponible',
    sources,
    freshness
  }
}

/**
 * Fabrique le handler `sdig_status`. `config` est la configuration propriétaire
 * `{ root, sources }` attendue par `openReadSnapshot` (les noms de source inconnus
 * sont ignorés). Retourne une fonction synchrone `(value, adaptations) => sortie`,
 * prête pour `McpServer.registerTool`.
 */
export function createStatusHandler (config) {
  return function sdigStatus (_value, _adaptations) {
    const configured = config && config.sources && typeof config.sources === 'object' && !Array.isArray(config.sources)
      ? config.sources
      : {}
    return openReadSnapshot(config, ({ view, freshness, availability }) =>
      buildStatus({ view, freshness, availability, configured })).data
  }
}

export { KNOWN_SOURCES }
