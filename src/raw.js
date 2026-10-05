// Recherche brute optionnelle dans raw/ (retour d'agent 16/09) : une erreur précise
// n'apparaît parfois que dans stderr — les sorties restent hors index BM25 par défaut,
// mais un scan sous-chaîne sur raw/ doit rester possible à la demande.
//
// Change scale-corpus : scan en flux — fichier par fichier, PAR BLOCS BORNÉS à
// l'intérieur de chaque fichier (recouvrement aux frontières : un match à cheval sur
// deux blocs n'est pas perdu) — l'empreinte mémoire ne dépend ni du nombre ni de la
// taille des fichiers raw. Les références (rawRef → événement) viennent de la vue
// (table rawrefs) — jamais d'un chargement du corpus.
import fs from 'node:fs'
import path from 'node:path'
import { openView } from './view.js'
import { rawShardPath } from './layout.js'
import { scanTextFd } from './util.js'
import { corpusPaths } from './paths.js'

/**
 * Ouverture CONFINÉE d'une preuve (add-pi-adapter, revue finale) : chaque
 * composante du chemin sous raw/ est vérifiée par lstat (répertoire réel, pas un
 * lien symbolique), le fichier est ouvert puis validé par fstat (fichier
 * régulier obligatoire) — la lecture se fait depuis le fd ouvert, jamais d'une
 * réouverture par chemin (TOCTOU écarté ; la fenêtre lstat→open sur une
 * composante reste théorique, pas d'O_NOFOLLOW exposé par Node — hypothèse
 * documentée). Retourne { fd } ou { error }.
 */
export function openProofFd (rawRoot, partId) {
  const resolvedRoot = path.resolve(rawRoot)
  const resolvedFile = path.resolve(rawShardPath(resolvedRoot, partId))
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
    return { error: 'hors du répertoire des preuves' }
  }
  const relParts = resolvedFile.slice(resolvedRoot.length + 1).split(path.sep)
  let dir = resolvedRoot
  for (const part of relParts.slice(0, -1)) {
    dir = path.join(dir, part)
    let lst
    try { lst = fs.lstatSync(dir) } catch (e) { return { error: `introuvable (${e.code})` } }
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      return { error: 'composante de chemin non répertoire (lien symbolique ?)' }
    }
  }
  // composante FINALE : lstat (jamais suivi) — un lien symbolique est refusé
  // avant toute ouverture, même si sa cible est un fichier régulier
  let finalLst
  try { finalLst = fs.lstatSync(resolvedFile) } catch (e) { return { error: `introuvable (${e.code})` } }
  if (finalLst.isSymbolicLink()) return { error: 'lien symbolique refusé' }
  let fd
  try { fd = fs.openSync(resolvedFile, 'r') } catch (e) { return { error: `introuvable (${e.code})` } }
  const fst = fs.fstatSync(fd)
  if (!fst.isFile()) { fs.closeSync(fd); return { error: 'ni fichier régulier (spécial ?)' } }
  return { fd, file: resolvedFile }
}

/**
 * Scan sous-chaîne (insensible à la casse) des sorties brutes référencées par le corpus.
 * `source` (add-pi-adapter, D5) : borne le scan aux preuves de la source — les
 * partId pi sont préfixés `pi:` (les orphelines pi, sans référence, restent hors
 * scan par conception, lisibles par `sdig raw <partId>` explicite) ; `opencode`
 * n'en lit aucune. Retourne [{ rawRef, sessionId, ts, role, tool, cmd, line, lineNo }]
 * borné par limit. Durée affichée par le CLI : coût O(volume de raw/ parcouru).
 *
 * Références parcourues EN FLUX (scale-corpus, mémoire bornée) : l'itérateur
 * better-sqlite3 consomme `rawrefs` ligne à ligne — plus de `.all()` ni de
 * plafond arbitraire, une seule référence transférée à la fois. La connexion, son
 * itérateur et le fd de chaque preuve sont refermés sur TOUS les chemins
 * (épuisement, `break` sur limit, erreur DB, erreur de lecture d'une preuve) ;
 * l'erreur de lecture d'une preuve n'est jamais avalée par un catch global.
 */
export function rawScan (root, needle, { limit = 10, source = null } = {}) {
  if (!needle || !needle.trim()) return []
  // add-pi-adapter (D5, revue étape 3) : `all`/null = toutes les preuves
  // référencées ; `pi`/`opencode` = famille du partId ; TOUTE autre valeur
  // (y compris chaîne vide) = zéro preuve, SANS AUCUNE lecture (cohérent avec
  // « source inconnue = zéro résultat » de la recherche).
  if (source != null && source !== 'all' && source !== 'pi' && source !== 'opencode') return []
  const paths = corpusPaths(root)
  const out = []

  // vue absente/refusée : aucune preuve resituable — scan rendu vide sans crash
  // (refus historique conservé) ; `openView` referme déjà la connexion sur ses
  // propres motifs de refus, il n'y a donc rien à nettoyer ici.
  let db
  try {
    db = openView(root)
  } catch {
    return []
  }

  // références depuis la vue : le préfixe du partId détermine la source, sans
  // lecture des preuves des autres sources. `.iterate()` reste PARESSEUX et
  // rend les lignes dans l'ordre QUE `.all()` rendait (même requête, sans tri
  // ajouté) ; l'itérateur retient la connexion tant qu'il est vivant, donc son
  // nettoyage précède TOUJOURS `db.close()` dans le finally.
  let refs = null
  try {
    const sql = 'SELECT rawRef, eventId, sessionId, ts, role, tool, cmd FROM rawrefs' +
      (source === 'pi' ? " WHERE rawRef LIKE 'pi:%'" : source === 'opencode' ? " WHERE rawRef NOT LIKE 'pi:%'" : '')
    refs = db.prepare(sql).iterate()
    for (const ref of refs) {
      if (out.length >= limit) break
      // sessions touchées seulement : shard de l'événement porteur (1 fichier
      // par ref), ouverture CONFINÉE (revue finale) — une preuve refusée (lien,
      // hors raw/, spéciale) est ignorée, jamais lue
      const opened = openProofFd(paths.raw, ref.rawRef)
      if (opened.error) continue // sortie refusée ou absente : ignorée
      let found = null
      try {
        scanTextFd(opened.fd, needle, { onMatch: (line, lineNo) => {
          found = { line, lineNo }
          return false // première correspondance par preuve
        } })
      } finally { fs.closeSync(opened.fd) }
      if (found) {
        out.push({
          rawRef: ref.rawRef,
          sessionId: ref.sessionId,
          ts: ref.ts,
          role: ref.role,
          tool: ref.tool,
          cmd: ref.cmd,
          line: found.line,
          lineNo: found.lineNo
        })
        // Arrêt AVANT de solliciter la référence suivante, même si celle-ci
        // déclencherait une erreur d'itération : le résultat demandé est atteint.
        if (out.length >= limit) break
      }
    }
  } finally {
    // libère l'itérateur : `break`, épuisement ou erreur en cours de parcours —
    // `db.close()` refuse une connexion à itérateur actif ; l'appel est
    // idempotent quand il est déjà épuisé. Une erreur de lecture de preuve
    // remonte APRÈS ce nettoyage (aucun catch ici ne l'avale).
    try { refs?.return?.() } finally { db.close() }
  }
  return out
}
