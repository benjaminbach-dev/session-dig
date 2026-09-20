// Layout v2 (change scale-corpus) : shards d'événements par session + préfixe
// de répartition par condensat. Les enregistrements (schéma d'un événement, d'une
// session) sont strictement inchangés depuis la v1 — seule la découpe des fichiers
// change, portée par layoutVersion dans state.json.
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { corpusPaths } from './paths.js'

export const LAYOUT_VERSION = 2

// <p> = deux premiers caractères hexadécimaux du md5 de l'identifiant — condensat
// ÉPINGLÉ à l'implémentation (une reconstruction identique produit les mêmes chemins).
// Les identifiants opencode partagent un préfixe constant (ses_, prt_) : un préfixe
// tiré des premiers caractères de l'id concentrerait la totalité des fichiers dans
// un seul répertoire ; le condensat répartit uniformément (256 répertoires).
export function shardPrefix (id) {
  return crypto.createHash('md5').update(String(id)).digest('hex').slice(0, 2)
}

// Shard d'événements d'une session : events/<p>/<sessionId>.jsonl
export function shardPath (root, sessionId) {
  return path.join(root, 'events', shardPrefix(sessionId), `${sessionId}.jsonl`)
}

// Preuve brute shardée : raw/<p>/<partId>.txt
export function rawShardPath (rawRoot, partId) {
  return path.join(rawRoot, shardPrefix(partId), `${partId}.txt`)
}

// Tous les shards d'événements (chemins relatifs triés — empreinte déterministe).
export function listShards (root) {
  const eventsDir = path.join(root, 'events')
  const out = []
  let dirs
  try { dirs = fs.readdirSync(eventsDir) } catch { return out }
  for (const d of dirs.sort()) {
    let files
    try { files = fs.readdirSync(path.join(eventsDir, d)) } catch { continue }
    for (const f of files.sort()) if (f.endsWith('.jsonl')) out.push(path.join('events', d, f))
  }
  return out
}

// Refus explicite de tout layout inconnu : versions lue ET attendue nommées,
// jamais d'interprétation implicite d'un layout différent.
export function assertLayout (state) {
  const got = state == null ? 1 : (state.layoutVersion ?? 1)
  if (got !== LAYOUT_VERSION) {
    throw new Error(`layout de corpus non support : lu v${got}, attendu v${LAYOUT_VERSION} — migrer (sdig migrate) ou re-ingérer depuis la source (sdig ingest --rebuild)`)
  }
}

// Marqueur persistant d'ingestion en cours (défini ici — layout — pour rester
// importable par view.js sans cycle corpus.js → view.js → corpus.js).
export function markerPath (root = corpusPaths().root) { return corpusPaths(root).marker }
export function ingestRunning (root = corpusPaths().root) { return fs.existsSync(markerPath(root)) }
