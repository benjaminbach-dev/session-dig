import path from 'node:path'
import os from 'node:os'

// Racine par défaut : ~/.local/share/session-dig/ (spec corpus : emplacement par défaut).
// Le corpus vit directement dedans (events.jsonl, sessions.jsonl, raw/, state.json),
// l'index BM25 est un fichier distinct (index.db) — vue dérivée, jetable.
export function corpusRoot () {
  return process.env.SESSION_DIG_HOME || path.join(os.homedir(), '.local', 'share', 'session-dig')
}

// Base source opencode (lecture seule stricte).
export function sourceDb (explicit) {
  return explicit || process.env.SESSION_DIG_DB || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

export function corpusPaths (root = corpusRoot()) {
  return {
    root,
    events: path.join(root, 'events.jsonl'),
    sessions: path.join(root, 'sessions.jsonl'),
    raw: path.join(root, 'raw'),
    state: path.join(root, 'state.json'),
    index: path.join(root, 'index.db')
  }
}
