// Recherche brute optionnelle dans raw/ (retour d'agent 16/09) : une erreur précise
// n'apparaît parfois que dans stderr — les sorties restent hors index BM25 par défaut,
// mais un scan sous-chaîne sur raw/*.txt doit rester possible à la demande.
import fs from 'node:fs'
import path from 'node:path'
import { loadCorpus } from './corpus.js'
import { corpusPaths } from './paths.js'

/**
 * Scan sous-chaîne (insensible à la casse) des sorties brutes référencées par le corpus.
 * Retourne [{ rawRef, sessionId, ts, role, tool, cmd, line }] borné par limit.
 */
export function rawScan (root, needle, { limit = 10 } = {}) {
  if (!needle || !needle.trim()) return []
  const { paths, events } = loadCorpus(root)
  const byRef = new Map() // rawRef → event (pour resituer le hit)
  for (const e of events) {
    for (const c of e.toolCalls || []) {
      if (c.rawRef && !byRef.has(c.rawRef)) byRef.set(c.rawRef, e)
    }
  }
  const low = needle.toLowerCase()
  const out = []
  let files
  try { files = fs.readdirSync(paths.raw) } catch { return [] }
  for (const f of files) {
    if (!f.endsWith('.txt')) continue
    const ref = f.slice(0, -4)
    const ev = byRef.get(ref)
    if (!ev) continue // sortie orpheline (part sans message dans le corpus) : ignorée
    let content
    try { content = fs.readFileSync(path.join(paths.raw, f), 'utf8') } catch { continue }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(low)) {
        const call = (ev.toolCalls || []).find(c => c.rawRef === ref)
        out.push({
          rawRef: ref, sessionId: ev.sessionId, ts: ev.ts, role: ev.role,
          tool: call?.tool ?? null, cmd: call?.cmd ?? null,
          line: lines[i].trim().slice(0, 200), lineNo: i + 1
        })
        break // première ligne suffît à resituer
      }
    }
    if (out.length >= limit) break
  }
  return out
}
