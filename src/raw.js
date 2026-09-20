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
import { openView } from './view.js'
import { rawShardPath } from './layout.js'
import { scanText } from './util.js'
import { corpusPaths } from './paths.js'

/**
 * Scan sous-chaîne (insensible à la casse) des sorties brutes référencées par le corpus.
 * Retourne [{ rawRef, sessionId, ts, role, tool, cmd, line, lineNo }] borné par limit.
 * Durée affichée par le CLI : son coût O(volume de raw/) est une opération consciente.
 */
export function rawScan (root, needle, { limit = 10 } = {}) {
  if (!needle || !needle.trim()) return []
  const paths = corpusPaths(root)
  const out = []

  // références depuis la vue (borné : requête indexée par rawRef)
  let refs
  try {
    const db = openView(root)
    refs = db.prepare('SELECT rawRef, eventId, sessionId, ts, role, tool, cmd FROM rawrefs LIMIT 1000000').all()
    db.close()
  } catch {
    refs = [] // vue absente : aucune preuve resituable — scan rendra vide sans crash
  }
  if (!refs.length) return []

  // sessions touchées seulement : shard de l'événement porteur (1 fichier par ref)
  for (const ref of refs) {
    if (out.length >= limit) break
    const file = rawShardPath(paths.raw, ref.rawRef)
    if (!fs.existsSync(file)) continue // sortie orpheline : ignorée
    let found = null
    scanText(file, needle, { onMatch: (line, lineNo) => {
      found = { line, lineNo }
      return false // première correspondance par preuve ; algorithme traité au lot 2
    } })
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
