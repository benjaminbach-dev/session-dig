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

  // références depuis la vue (borné : requête indexée par rawRef) — le préfixe
  // du partId détermine la source, sans lecture des preuves des autres sources
  let refs
  try {
    const db = openView(root)
    const sql = 'SELECT rawRef, eventId, sessionId, ts, role, tool, cmd FROM rawrefs' +
      (source === 'pi' ? " WHERE rawRef LIKE 'pi:%'" : source === 'opencode' ? " WHERE rawRef NOT LIKE 'pi:%'" : '') +
      ' LIMIT 1000000'
    refs = db.prepare(sql).all()
    db.close()
  } catch {
    refs = [] // vue absente : aucune preuve resituable — scan rendra vide sans crash
  }
  if (!refs.length) return []

  // sessions touchées seulement : shard de l'événement porteur (1 fichier par ref)
  // ouverture CONFINÉE par ref (revue finale) : parents vérifiés, fstat du fd —
  // une preuve refusée (lien, hors raw/, spéciale) est ignorée, jamais lue
  for (const ref of refs) {
    if (out.length >= limit) break
    const opened = openProofFd(paths.raw, ref.rawRef)
    if (opened.error) continue // sortie refusée ou absente : ignorée
    let found = null
    try {
      scanTextFd(opened.fd, needle, { onMatch: (line, lineNo) => {
        found = { line, lineNo }
        return false // première correspondance par preuve ; algorithme traité au lot 2
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
    }
  }
  return out
}
