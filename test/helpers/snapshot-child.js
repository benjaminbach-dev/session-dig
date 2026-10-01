// A4 : lecteur CLI réel, suspendu par IPC à une frontière SQLite précise.
// Hooks enfant uniquement ; aucune API de test dans le code de production.
import fs from 'node:fs'
import Database from 'better-sqlite3'

const point = process.env.SNAPSHOT_POINT
let armed = true
function pause () {
  if (!armed) return
  armed = false
  process.send({ type: 'paused', point })
  const byte = Buffer.alloc(1)
  for (;;) {
    let n
    try { n = fs.readSync(0, byte, 0, 1, null) } catch (e) {
      if (e.code === 'EAGAIN') continue
      throw e
    }
    if (n > 0) return
    throw new Error('barrière A4 : stdin fermé avant reprise explicite')
  }
}

if (point === 'before-begin') {
  const exec = Database.prototype.exec
  Database.prototype.exec = function (sql, ...args) {
    if (sql.trim().toUpperCase() === 'BEGIN') pause()
    return exec.call(this, sql, ...args)
  }
} else {
  const prepare = Database.prototype.prepare
  Database.prototype.prepare = function (sql, ...args) {
    const stmt = prepare.call(this, sql, ...args)
    const method = point === 'after-hits' && sql.includes('JOIN events_fts')
      ? 'all'
      : point === 'after-meta' && sql.includes('SELECT json FROM sessions WHERE id = ?') ? 'get' : null
    if (method) {
      const query = stmt[method]
      stmt[method] = function (...params) {
        const result = query.apply(this, params)
        pause() // la première donnée appartient déjà au snapshot du lecteur
        return result
      }
    }
    return stmt
  }
}

process.argv = [process.execPath, new URL('../../bin/sdig.js', import.meta.url).pathname,
  ...JSON.parse(process.env.SNAPSHOT_ARGS)]
await import('../../bin/sdig.js')
// Pas de listener IPC : le CLI quitte naturellement après son travail.
