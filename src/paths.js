import path from 'node:path'
import os from 'node:os'

// Racine par défaut : ~/.local/share/session-dig/ (spec corpus : emplacement par défaut).
// Layout v2 (change scale-corpus) : shards events/<p>/<sessionId>.jsonl, sessions.jsonl,
// raw/<p>/<partId>.txt, state.json — la vue dérivable (view.db, chemin de lecture) et
// l'index de recherche (index.db) sont des fichiers dérivés distincts et jetables.
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
    events: path.join(root, 'events.jsonl'), // v1 uniquement (migration) — ignoré en v2
    eventsDir: path.join(root, 'events'),
    sessions: path.join(root, 'sessions.jsonl'),
    raw: path.join(root, 'raw'),
    state: path.join(root, 'state.json'),
    index: path.join(root, 'index.db'),
    view: path.join(root, 'view.db'),
    marker: path.join(root, '.ingest-in-progress'),
    lock: path.join(root, '.ingest-lock')
  }
}
