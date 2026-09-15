// Fixture synthétique : base opencode-like minimaliste (mêmes colonnes que celles lues
// par l'adaptateur) + corpus doré pour les requêtes. Jamais de données réelles.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export const T0 = Date.UTC(2026, 5, 10, 10, 0, 0) // 2026-06-10

export function buildFixtureDb (dbPath) {
  fs.rmSync(dbPath, { force: true })
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true })
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'p', parent_id TEXT,
      slug TEXT DEFAULT 's', directory TEXT, title TEXT, version TEXT,
      share_url TEXT, summary_additions INTEGER DEFAULT 0, summary_deletions INTEGER DEFAULT 0,
      summary_files INTEGER DEFAULT 0, summary_diffs TEXT, revert TEXT, permission TEXT,
      time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER,
      workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
      cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE message(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
    CREATE TABLE part(
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
  `)

  const insSes = db.prepare(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, cost, tokens_input, tokens_output, tokens_cache_read) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const insMsg = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
  const insPart = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)

  const msg = (id, ses, t, data) => insMsg.run(id, ses, t, t, JSON.stringify(data))
  const part = (id, mid, ses, t, data) => insPart.run(id, mid, ses, t, t, JSON.stringify(data))

  // ── Session 1 : le bug du proxy (requête dorée « proxy 461 ») ──
  insSes.run('ses_fix1', null, '/root/ccp-proxy', 'Fix bug proxy 461', T0, T0 + 60000, 0.01, 5000, 800, 20000)
  msg('msg_u1', 'ses_fix1', T0 + 1000, { role: 'user', agent: 'build', model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' } })
  part('prt_u1', 'msg_u1', 'ses_fix1', T0 + 1000, { type: 'text', text: 'le proxy renvoie 461 sans cesse sur le endpoint go, surtout en fin de mois' })
  msg('msg_a1', 'ses_fix1', T0 + 2000, { role: 'assistant', agent: 'build', providerID: 'opencode-go', modelID: 'deepseek-v4-flash', cost: 0.004, tokens: { total: 1200, input: 900, output: 300, reasoning: 10, cache: { read: 0, write: 0 } } })
  part('prt_a1t', 'msg_a1', 'ses_fix1', T0 + 2000, { type: 'text', text: 'Corrigé : le timeout upstream était trop court, augmenté à 30s dans config.json' })
  part('prt_a1tool', 'msg_a1', 'ses_fix1', T0 + 2500, { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'git revert abc123' }, output: 'revert ok\n', metadata: { exitCode: 0 } } })
  // message à 2 appels d'outils (cas réel constaté : jusqu'à 34)
  msg('msg_a2', 'ses_fix1', T0 + 3000, { role: 'assistant', agent: 'build', providerID: 'opencode-go', modelID: 'glm-5.2' })
  part('prt_a2t', 'msg_a2', 'ses_fix1', T0 + 3000, { type: 'text', text: 'Je relance le build pour vérifier' })
  part('prt_a2tool1', 'msg_a2', 'ses_fix1', T0 + 3100, { type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'completed', input: { command: 'go build ./...' }, output: 'ok\n', metadata: { exitCode: 0 } } })
  part('prt_a2tool2', 'msg_a2', 'ses_fix1', T0 + 3200, { type: 'tool', tool: 'read', callID: 'c3', state: { status: 'completed', input: { file: 'config.json' }, output: '{ "timeout": 30 }' } })
  part('prt_a2sf', 'msg_a2', 'ses_fix1', T0 + 3300, { type: 'step-finish', reason: 'stop', cost: 0.001, tokens: { total: 500, input: 400, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } })

  // ── Session 2 : design (repo theme-kit) ──
  insSes.run('ses_fix2', null, '/root/theme-kit', 'Design thème sombre', T0 + 86400000, T0 + 90000000, 0.02, 3000, 600, 9000)
  msg('msg_u2', 'ses_fix2', T0 + 86401000, { role: 'user', agent: 'plan', model: { providerID: 'openai', modelID: 'gpt-5.6-luna' } })
  part('prt_u2', 'msg_u2', 'ses_fix2', T0 + 86401000, { type: 'text', text: 'propose une palette lila pour le thème sombre du site' })

  // ── Session 3 : directory = home → repo null ──
  insSes.run('ses_fix3', 'ses_fix1', '/root', 'Sous-agent setup', T0 + 172800000, T0 + 173000000, 0, 100, 20, 0)
  msg('msg_u3', 'ses_fix3', T0 + 172801000, { role: 'user', agent: 'explore', model: { providerID: 'opencode', modelID: 'big-pickle' } })
  part('prt_u3', 'msg_u3', 'ses_fix3', T0 + 172801000, { type: 'text', text: 'setup termux debian proot' })

  db.close()
  return dbPath
}

// Corpus doré équivalent (pour les tests retriever sans passer par l'adaptateur).
export function goldenCorpusEvents () {
  return [
    { schemaVersion: 1, id: 'msg_u1', sessionId: 'ses_fix1', ts: T0 + 1000, role: 'user', text: 'le proxy renvoie 461 sans cesse sur le endpoint go', model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' }, agent: 'build', repo: 'ccp-proxy', tokens: { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
    { schemaVersion: 1, id: 'msg_a1', sessionId: 'ses_fix1', ts: T0 + 2000, role: 'assistant', text: 'Corrigé : le timeout upstream était trop court', model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' }, agent: 'build', repo: 'ccp-proxy', tokens: { in: 900, out: 300, reasoning: 10, cacheRead: 0, cacheWrite: 0 }, cost: 0.004, toolCalls: [{ tool: 'bash', cmd: 'git revert abc123', exitCode: 0 }] },
    { schemaVersion: 1, id: 'msg_u2', sessionId: 'ses_fix2', ts: T0 + 86401000, role: 'user', text: 'propose une palette lila pour le thème sombre', model: { providerID: 'openai', modelID: 'gpt-5.6-luna' }, agent: 'plan', repo: 'theme-kit', tokens: { in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
  ]
}
