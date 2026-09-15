import Database from 'better-sqlite3'

const db = new Database('/root/.local/share/opencode/opencode.db', { readonly: true, fileMustExist: true })
const q = (sql, ...a) => db.prepare(sql).all(...a)

console.log('=== roles messages ===')
for (const r of q(`SELECT json_extract(data,'$.role') role, COUNT(*) n FROM message GROUP BY role`)) console.log(r.role, r.n)

console.log('=== types parts ===')
for (const r of q(`SELECT json_extract(data,'$.type') t, COUNT(*) n FROM part GROUP BY t`)) console.log(r.t, r.n)

console.log('=== step-finish sample ===')
const sf = q(`SELECT data FROM part WHERE json_extract(data,'$.type')='step-finish' AND json_extract(data,'$.cost') > 0 LIMIT 1`)[0]
console.log(sf ? JSON.stringify(JSON.parse(sf.data)).slice(0, 500) : 'aucun avec cost>0')

console.log('=== message assistant sample ===')
const m = q(`SELECT data FROM message WHERE json_extract(data,'$.role')='assistant' LIMIT 1`)[0]
console.log(JSON.stringify(JSON.parse(m.data)).slice(0, 400))

console.log('=== tool part samples (2) ===')
const ts = q(`SELECT data FROM part WHERE json_extract(data,'$.type')='tool' LIMIT 2`)
for (const r of ts) console.log(JSON.stringify(JSON.parse(r.data)).slice(0, 700), '\n---')

console.log('=== exitCode présent ? ===')
const tools = q(`SELECT data FROM part WHERE json_extract(data,'$.type')='tool'`)
let withExit = 0, withState = 0, withOutput = 0
const keySets = new Set()
for (const r of tools) {
  const d = JSON.parse(r.data)
  if (d.state) {
    withState++
    keySets.add(Object.keys(d.state).sort().join(','))
    if (JSON.stringify(d.state).match(/exit/i)) withExit++
    if (d.state.output) withOutput++
  }
}
console.log('total tool:', tools.length, '| avec state:', withState, '| avec exit*:', withExit, '| avec output inline:', withOutput)
console.log('clés state distinctes:', [...keySets].slice(0, 10))

console.log('=== messages avec plusieurs tool calls ===')
for (const r of q(`SELECT message_id, COUNT(*) n FROM part WHERE json_extract(data,'$.type')='tool' GROUP BY message_id HAVING n>1 ORDER BY n DESC LIMIT 5`)) console.log(r.message_id, r.n)

console.log('=== distribution outils ===')
for (const r of q(`SELECT json_extract(data,'$.tool') tool, COUNT(*) n FROM part WHERE json_extract(data,'$.type')='tool' GROUP BY tool ORDER BY n DESC LIMIT 12`)) console.log(r.tool, r.n)

db.close()
