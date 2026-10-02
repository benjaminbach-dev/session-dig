// Adaptateur pi (change add-pi-adapter) : sessions JSONL append-only sous
// `~/.pi/agent/sessions` → schéma canonique, même contrat de sortie que
// `adaptPaged` opencode (batches `{sessions, events, rawOutputs}` groupés par
// session) — la boucle d'ingestion du corpus fusionne les deux flux dans le
// même staging (corpus.js, phase implémentation, hors périmètre ici).
//
// Formes canoniques réutilisées depuis opencode-extract.js (point de vérité
// unique) : cmdFromInput, repoFromDirectory, normTokens, addTokens. Champ
// `source: "pi"` sur toute session et tout événement produits (D1) ; ids
// préfixés `pi:` — sessionId `pi:<uuid>`, id d'événement et partIds QUALIFIÉS
// PAR SESSION (`pi:<uuid>:<id local>`, D1/D5 amendés : les ids de lignes pi ne
// sont pas uniques entre fichiers — fork/reprise rejouent des ids identiques).
//
// Relecture 27/09 (design D4, « Ordre canonique », « Départage des preuves »,
// « Ids sûrs ») : ordre des événements trié par (ts, id) ; le toolResult est
// autoritaire pour son appel, la décision bash est révisable jusqu'à la fin du
// fichier (jamais d'écrasement de partId) ; aucune preuve vide (champ absent ≠
// chaîne présente) ; tout id dérivé en partId/chemin est validé (jeu sûr, pas
// de collision locale au sein du fichier).
//
// Lecture seule stricte (D6) : jamais d'écriture sous le répertoire source ;
// sessions vivantes lues telles quelles — ligne finale non terminée ignorée
// sans erreur, ligne terminée invalide (JSON ou vide) = échec explicite (D2).
import fs from 'node:fs'
import path from 'node:path'
import { cmdFromInput, repoFromDirectory, normTokens, addTokens } from './opencode-extract.js'

// Types ignorés en v0 (perte documentée, réversible par rebuild) — D4.
const IGNORED_TYPES = new Set([
  'model_change', 'thinking_level_change', 'compaction', 'branch_summary',
  'custom', 'custom_message', 'context_edit'
])

const ZERO_TOKENS = Object.freeze({ in: 0, out: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

// ── Ids sûrs (design D4, « Ids sûrs ») : tout id dérivé en partId/chemin est
// validé avant usage — liste de REFUS : '/' et '\\' (séparateurs de chemin),
// ':' (séparateur réservé du partId — absence confirmée dans les 85 fichiers
// réels), caractères de contrôle, séquence '..' et blancs en début/fin ;
// unicité locale au sein du fichier vérifiée par l'appelant (claimLocal).
// Le repli `line-<n>` est sûr par construction. '|' est CONSERVÉ littéralement
// (761 ids d'appels pi réels le contiennent, ex. call_…|fc_…) : caractère de
// nom de fichier ordinaire sur Unix — toute usage en shell doit citer le
// partId ; portabilité Windows non promise (design).
const UNSAFE_ID_RE = /[\\/:\x00-\x1f\x7f]/
const isSafeId = (id) => typeof id === 'string' && id !== '' &&
  !UNSAFE_ID_RE.test(id) && !id.includes('..') && id.trim() === id

// ── Lecture d'un fichier en lignes TERMINÉES (D2) ──
// Relecture INTÉGRALE à chaque changement (l'offset source n'est pas un état
// exploitable). Retourne les lignes terminées par \n et l'acquit : offset du
// dernier octet de la dernière ligne terminée — une ligne finale sans \n
// n'est jamais acquittée, le fichier sera relu.
function readTerminatedLines (absPath) {
  const data = fs.readFileSync(absPath)
  const lines = []
  let start = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push({ text: data.toString('utf8', start, i) })
      start = i + 1
    }
  }
  return { lines, ack: start }
}

// ── ts d'une ligne : message.timestamp (ms) prioritaire, repli Date.parse du
// timestamp ISO de l'enveloppe. null = aucune horloge exploitable (l'appelant
// décide : échec explicite pour un événement, jamais de ts null publié).
function tsOf (msgObj, envelope) {
  if (msgObj && Number.isFinite(msgObj.timestamp)) return msgObj.timestamp
  const iso = envelope && envelope.timestamp
  if (typeof iso === 'string') {
    const t = Date.parse(iso)
    if (Number.isFinite(t)) return t
  }
  return null
}

// ── model canonique depuis message.provider / message.model (la source les met à plat) ──
function modelOf (m) {
  const has = (m && typeof m.provider === 'string' && m.provider) ||
    (m && typeof m.model === 'string' && m.model)
  if (!has) return { providerID: null, modelID: null }
  return { providerID: m.provider ?? null, modelID: m.model ?? null }
}

// ── usage du message → tokens/cost canoniques (messages user → zéros, D4) ──
// L'usage pi expose cacheRead/cacheWrite À PLAT (forme observée) ; normTokens
// (forme canonique opencode) lit cache.{read,write} — on réconcilie ici : la
// sortie reste la forme canonique {in, out, reasoning, cacheRead, cacheWrite}.
function tokensOf (usage) {
  if (!usage || typeof usage !== 'object') return null
  const t = normTokens(usage)
  if (t == null) return null
  const cr = Number.isFinite(usage.cacheRead) ? usage.cacheRead : t.cacheRead
  const cw = Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : t.cacheWrite
  return { ...t, cacheRead: cr, cacheWrite: cw }
}
function metricsOf (msgObj, isUser) {
  if (isUser) return { tokens: { ...ZERO_TOKENS }, cost: 0 }
  const c = msgObj && msgObj.usage && msgObj.usage.cost
  return {
    tokens: tokensOf(msgObj && msgObj.usage) ?? { ...ZERO_TOKENS },
    cost: c && typeof c.total === 'number' ? c.total : 0
  }
}

// ── parts text jointes par \n\n (parts thinking ignorées, D4) ──
function textOf (msgObj) {
  const content = msgObj && Array.isArray(msgObj.content) ? msgObj.content : []
  const texts = []
  for (const p of content) {
    if (p && p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
  }
  return texts.length ? texts.join('\n\n') : null
}

const isBashTool = (tool) => tool === 'bash' || tool === 'Bash'

// ── parts toolCall → toolCalls canoniques {tool, cmd} (cmd = champ le plus
// parlant des arguments) via cmdFromInput, D4 ; callId conservé pour le
// rattachement, retiré de la forme publiée).
function toolCallsOf (msgObj) {
  const content = msgObj && Array.isArray(msgObj.content) ? msgObj.content : []
  const calls = []
  for (const p of content) {
    if (p && p.type === 'toolCall') {
      calls.push({
        callId: p.id ?? null,
        tool: typeof p.name === 'string' ? p.name : (p.name != null ? String(p.name) : null),
        cmd: cmdFromInput(p.arguments) ?? null
      })
    }
  }
  return calls
}

// Dernière enveloppe du fichier, en parse défensif (timestamp de session).
function safeParse (text) {
  try { return JSON.parse(text) } catch { return null }
}

// Ordre canonique intra-session : (ts, id) — l'ordre des lignes du fichier ne
// suffit pas (branchement D4, revue 27/09).
const evSort = (a, b) => {
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

//
// ── Décodage d'un fichier pi (mapping D4/D5, appelé par adaptPi) ──
// Toutes les lignes terminées sont validées (non vides + JSON), même quand
// l'en-tête n'est pas une session — jamais d'abandon silencieux (D2). Une
// ligne finale non terminée n'apparaît pas ici (readTerminatedLines).
function decodePiFile (absPath, relPath, baseDir) {
  const { lines, ack } = readTerminatedLines(absPath)
  const err = (lineNo, msg) => new Error(`${path.join(baseDir, relPath)}:${lineNo}: ${msg}`)
  const empty = { session: null, events: [], rawOutputs: [], orphans: [], ignored: {}, ack }

  const parsed = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text
    if (text === '') throw err(i + 1, 'ligne terminée vide (seule la ligne finale non terminée est tolérée)')
    try { parsed.push(JSON.parse(text)) } catch (e) { throw err(i + 1, `JSON invalide (${e.message})`) }
  }
  if (!parsed.length) return empty

  // Ligne 1 : en-tête. session_info → fichier de titre seul : consommé (validé
  // ci-dessus), aucun objet produit. Tout autre type : échec explicite.
  const header = parsed[0]
  const headType = header && header.type
  if (headType === 'session_info') return empty
  if (headType !== 'session') {
    throw err(1, `première ligne attendue de type "session" (type=${JSON.stringify(headType)})`)
  }
  const uuid = header.id
  if (!isSafeId(uuid)) throw err(1, `ligne "session" : id invalide ou manquant (${JSON.stringify(uuid)})`)
  const tsCreated = tsOf(null, header)
  if (!Number.isFinite(tsCreated)) throw err(1, 'ligne "session" sans timestamp ISO exploitable')
  const sessionId = `pi:${uuid}`
  const directory = typeof header.cwd === 'string' ? header.cwd : null
  const repo = repoFromDirectory(directory)

  const events = []
  const rawOutputs = []
  const orphans = []
  const ignored = Object.create(null) // revue finale : __proto__/constructor comptés, zéro pollution
  let firstUserText = null
  let lastInfo = null

  // ── Ids sûrs : unicité locale au fichier de tout id dérivé en id d'événement
  // ou en partId (ids de lignes ET ids d'appels partagent l'espace des locaux —
  // une collision produirait deux preuves sous le même partId).
  const usedLocals = new Map() // id local → numéro de ligne (0-based)
  const claimLocal = (local, lineNo) => {
    const seen = usedLocals.get(local)
    if (seen !== undefined) {
      throw err(lineNo + 1, `collision d'id local ${JSON.stringify(local)} (déjà utilisé ligne ${seen + 1})`)
    }
    usedLocals.set(local, lineNo)
  }

  // ── Départage des preuves (design D4) : la décision bash est révisable
  // jusqu'à la fin du fichier. calls : callId → { call (objet publié), tool,
  // toolResult, bash } ; openBash : pile des callId bash non résolus.
  const calls = new Map()
  const openBash = []
  const bump = (type) => { ignored[type] = (ignored[type] || 0) + 1 }
  const qualify = (local) => `pi:${uuid}:${local}`

  const emitEvent = (m, lineId, lineEnv, lineNo) => {
    const isUser = m.role === 'user'
    const met = metricsOf(m, isUser)
    const ts = tsOf(m, lineEnv)
    if (!Number.isFinite(ts)) {
      throw err(lineNo + 1, 'ni message.timestamp ni timestamp d\'enveloppe exploitable')
    }
    const ev = {
      schemaVersion: 1,
      source: 'pi',
      // D1 amendé (27/09) : id d'événement QUALIFIÉ PAR SESSION — les ids de
      // lignes pi ne sont pas uniques entre fichiers (fork/reprise rejouent des
      // messages aux ids identiques, constaté sur le corpus réel) ; la
      // qualification garantit l'absence de collision d'events.id. L'id est
      // construit par l'adaptateur : les ids SOURCE restent validés sans ':'.
      id: `pi:${uuid}:${lineId}`,
      sessionId,
      ts,
      role: m.role,
      text: textOf(m),
      model: modelOf(m),
      agent: null,
      repo,
      tokens: met.tokens,
      cost: met.cost
    }
    const callsOfLine = toolCallsOf(m)
    if (callsOfLine.length) {
      ev.toolCalls = callsOfLine.map(({ callId, ...rest }) => rest)
      callsOfLine.forEach((c, i) => {
        if (c.callId == null || c.callId === '') return
        if (!isSafeId(c.callId)) throw err(lineNo + 1, `id d'appel invalide (${JSON.stringify(c.callId)})`)
        claimLocal(c.callId, lineNo)
        const pub = ev.toolCalls[i]
        // callId conservé HORS sérialisation (non énumérable) : l'attachement
        // en a besoin, l'appelant ne doit pas le voir.
        Object.defineProperty(pub, '_callId', { value: c.callId, enumerable: false })
        calls.set(c.callId, { call: pub, toolResult: null, bash: null })
        if (isBashTool(c.tool)) openBash.push(c.callId)
      })
    }
    events.push(ev)
  }

  // ── boucle de mapping (ordre fichier, lignes 2..N) ──
  for (let li = 1; li < parsed.length; li++) {
    const line = parsed[li]
    const type = line && line.type
    if (type !== 'message') {
      if (type === 'session_info') {
        lastInfo = (typeof line.name === 'string' && line.name) ? line.name : lastInfo
      } else if (IGNORED_TYPES.has(type)) {
        bump(type)
      } else {
        bump(String(type)) // type inconnu : ignoré + compté (défensif)
      }
      continue
    }
    const m = line.message
    if (!m || typeof m !== 'object') { bump('message:malformed'); continue }
    // id de ligne : id d'enveloppe validé (sûr + unique), repli line-<n> (sûr
    // par construction) — supposition D7.5 (unicité locale au fichier).
    let lineId
    if (line.id != null) {
      if (!isSafeId(line.id)) throw err(li + 1, `id de ligne invalide (${JSON.stringify(line.id)})`)
      lineId = line.id
    } else {
      lineId = `line-${li}`
    }
    claimLocal(lineId, li)
    const mrole = m.role
    if (mrole === 'user' || mrole === 'assistant') {
      emitEvent(m, lineId, line, li)
      if (mrole === 'user' && firstUserText === null) {
        const t = textOf(m)
        if (typeof t === 'string' && t) firstUserText = t
      }
      continue
    }
    if (mrole === 'toolResult') {
      // Sortie : jointure des parts text — champ ABSENT (aucune part / content
      // absent) ≠ chaîne présente éventuellement vide. Sans sortie disponible,
      // ni preuve ni rawRef (Départage des preuves).
      let content = null
      if (m.content && Array.isArray(m.content)) {
        const texts = m.content
          .filter(p => p && p.type === 'text' && typeof p.text === 'string')
          .map(p => p.text)
        if (texts.length) content = texts.join('\n')
      }
      const callId = m.toolCallId != null && m.toolCallId !== '' ? m.toolCallId : null
      const ticket = callId != null ? calls.get(callId) : null
      if (ticket && ticket.toolResult == null) {
        // AUTORITAIRE pour l'appel (le premier fait foi) : enregistrement différé
        // à la fin de fichier — un bashExecution provisoirement rattaché au même
        // appel sera déplacé en orphelin sous son propre id de ligne.
        // exitCode porté s'il est exposé (aucun toolResult réel ne l'expose
        // aujourd'hui — 0/2691 — mais la spec le prévoit).
        ticket.toolResult = {
          content,
          exitCode: typeof m.exitCode === 'number' ? m.exitCode : undefined
        }
        const open = openBash.indexOf(callId)
        if (open >= 0) openBash.splice(open, 1) // l'appel est résolu
        continue
      }
      // orphelin : sans appel correspondant, ou second toolResult du même appel
      // (le premier fait foi) — compté, listé sous son id de ligne, preuve
      // seulement si une sortie existe.
      const partId = qualify(lineId)
      orphans.push(partId)
      bump('orphan:toolResult')
      if (content != null) rawOutputs.push({ id: partId, content })
      continue
    }
    if (mrole === 'bashExecution') {
      const output = typeof m.output === 'string' ? m.output : null
      // rattachement PROVISOIRE au plus récent appel bash non résolu (le plus
      // récent dans l'ordre du fichier) — décision révisable jusqu'à la fin du
      // fichier si un toolResult du même appel apparaît ensuite.
      const callId = openBash.pop()
      if (callId != null) {
        calls.get(callId).bash = {
          output,
          exitCode: typeof m.exitCode === 'number' ? m.exitCode : undefined,
          cmd: (typeof m.command === 'string' && m.command) ? m.command : null,
          lineId
        }
        continue
      }
      // exécution orpheline (D5) : comptée, listée sous son id de ligne,
      // preuve seulement si une sortie existe.
      const partId = qualify(lineId)
      orphans.push(partId)
      bump('orphan:bashExecution')
      if (output != null) rawOutputs.push({ id: partId, content: output })
      continue
    }
    // system ou autre rôle inconnu : ignoré + compté (défensif).
    bump(`role:${mrole}`)
  }

  // ── fin de fichier : décision FINALE des rattachements (Départage des
  // preuves). Un partId d'appel n'est jamais écrasé : le toolResult est
  // autoritaire, la sortie d'un bashExecution déplacé devient orpheline.
  for (const [callId, ticket] of calls) {
    if (ticket.toolResult != null) {
      if (typeof ticket.toolResult.exitCode === 'number') {
        ticket.call.exitCode = ticket.toolResult.exitCode
      }
      if (ticket.toolResult.content != null) {
        const partId = qualify(callId)
        ticket.call.rawRef = partId
        rawOutputs.push({ id: partId, content: ticket.toolResult.content })
      }
      if (ticket.bash != null) {
        // bashExecution déplacé par le toolResult autoritaire : orphelin sous
        // SON id de ligne (compté, listé, preuve si sortie présente).
        const partId = qualify(ticket.bash.lineId)
        orphans.push(partId)
        bump('orphan:bashExecution')
        if (ticket.bash.output != null) rawOutputs.push({ id: partId, content: ticket.bash.output })
      }
      continue
    }
    if (ticket.bash != null) {
      // rattachement bash confirmé : le cmd réel de l'exécution prime sur celui
      // des arguments de l'appel ; exitCode ; preuve seulement si sortie présente.
      if (ticket.bash.cmd != null) ticket.call.cmd = ticket.bash.cmd
      if (typeof ticket.bash.exitCode === 'number') ticket.call.exitCode = ticket.bash.exitCode
      if (ticket.bash.output != null) {
        const partId = qualify(callId)
        ticket.call.rawRef = partId
        rawOutputs.push({ id: partId, content: ticket.bash.output })
      }
      continue
    }
    if (isBashTool(ticket.call.tool)) {
      // appel bash resté sans résultat en fin de fichier : compté (« appel sans
      // preuve »), JAMAIS de rawRef ni de preuve inventés.
      bump('call:bash-sans-preuve')
      Object.defineProperty(ticket.call, 'sansPreuve', { value: true, enumerable: false })
    }
  }

  // ── titre de session (décision de l'étape, amendement D7.2) : session_info.name
  // (dernière occurrence), repli premier texte user première ligne ≤ 60
  // caractères — une première ligne VIDE donne null (strict « sinon null »).
  let title = null
  if (typeof lastInfo === 'string' && lastInfo) {
    title = lastInfo
  } else if (firstUserText !== null) {
    const first = firstUserText.split('\n')[0]
    if (first !== '') title = first.slice(0, 60)
  }

  // tsCreated/tsUpdated : timestamp de la 1re / dernière ligne consommée.
  const tsUpdated = tsOf(null, parsed[parsed.length - 1]) ?? tsCreated

  // Métriques de session : SOMME des usage des messages (user → zéros).
  let tokens = { ...ZERO_TOKENS }
  let cost = 0
  for (const ev of events) {
    tokens = addTokens(tokens, ev.tokens)
    cost += ev.cost
  }

  const session = {
    schemaVersion: 1,
    source: 'pi',
    id: sessionId,
    title,
    directory,
    repo,
    tsCreated,
    tsUpdated,
    tokens,
    cost
  }
  return { session, events, rawOutputs, orphans, ignored, ack }
}

//
// ── Adaptateur pi : point d'entrée (contrat du change) ──
//   adaptPi(piDir, prevState, opts, onBatch)
//     prevState : { files: { "<relPath>": { size, mtimeMs } } } ({} au 1er passage)
//     opts      : { batchSize } (défaut 2000)
//     onBatch   : batch => … ({sessions, events, rawOutputs} groupés par session,
//                 ordre sessionId croissant) — émis au fil de la finalisation
//   retour     : { files, orphans, ignored, acked } (+ batches SANS onBatch)
//     files    : état par fichier, reconstruit depuis les fichiers PRÉSENTS —
//                entrée précédente recopiée pour les inchangés, nouvelle entrée
//                pour les changés (acquit = dernier octet de la dernière ligne
//                TERMINÉE, mtimeMs re-stat APRÈS lecture), clé ABSENTE pour les
//                fichiers disparus (les shards publiés restent : archive).
//     orphans  : partId des exécutions/résultats non référencés par un événement
//                (D5) — listés même sans preuve de sortie
//     ignored  : comptes { "<type>": n } des lignes/rôles ignorés
//     acked    : alias de files
//     batches  : les lots émis (UNIQUEMENT sans onBatch — commodité de test)
//
// Émission en flux PAR SESSION, après décodage complet des fichiers changés :
// le tri canonique (ts, id) et l'invariant un-UUID-un-fichier exigent de voir
// toutes les lignes terminées avant d'émettre. RÉTENTION proportionnelle aux
// fichiers changés (relecture intégrale + accumul par session avant émission)
// — acceptable à l'échelle observée (~85 fichiers, 20 Mo, design « Mémoire »),
// à borner si l'échelle augmente. La lecture intégrale d'un fichier reste
// conforme à D2 ; rien d'autre n'est accumulé.
export function adaptPi (piDir, prevState = {}, opts = {}, onBatch = null) {
  if (typeof piDir !== 'string' || piDir === '') {
    throw new Error('adaptPi : chemin de la source pi requis')
  }
  let dirStat = null
  try { dirStat = fs.statSync(piDir) } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`source pi introuvable : ${piDir}`)
    throw new Error(`source pi illisible (${piDir}) : ${e && e.message}`)
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`source pi invalide (pas un répertoire) : ${piDir}`)
  }
  const prevFiles = (prevState && prevState.files) || {}
  const batchSize = Math.max(1, (opts && opts.batchSize) || 2000)
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)

  // ── Découverte des fichiers (récursif, *.jsonl, dotfiles ignorés) ──
  // ENOENT (répertoire disparu en cours de parcours) = ignoré ; toute autre
  // erreur de parcours = échec explicite de la passe, avec le chemin.
  const files = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      if (e && e.code === 'ENOENT') return
      throw new Error(`source pi illisible (${dir}) : ${e && e.message}`)
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      // subagent-artifacts/ : journaux d'artefacts de sous-agents (transcripts
      // atypiques sans en-tête de session, journal de permissions) — hors
      // sessions, exclus de la découverte (les fichiers ordinaires homonymes,
      // eux, restent découverts).
      if (entry.isDirectory() && entry.name === 'subagent-artifacts') continue
      const abs = path.join(dir, entry.name)
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, r)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ rel: r, abs })
    }
  }
  walk(piDir, '')
  files.sort(byRel)

  // ── Détection de changement : O(stat), pas de lecture des fichiers inchangés.
  // Disparition concurrente (ENOENT) = fichier ignoré ; toute autre erreur
  // (EACCES…) = échec de la passe avec le chemin — pas de silence.
  // Migration ONE-SHOT (D1 amendé, revue finale) : un état antérieur sans uuid
  // propriétaire par fichier (forme d'avant l'invariant un-UUID-un-fichier) est
  // invalidé UNE FOIS — relecture intégrale des fichiers pi, état réécrit avec
  // les uuids. Coût unique (~20 Mo sur le réel), filet de la relecture intégrale.
  const uuidMigration = Object.values(prevFiles).some(f => f && f.uuid === undefined)
  const changed = []
  const unchanged = [] // [relPath, stat]
  for (const f of files) {
    let s
    try { s = fs.statSync(f.abs) } catch (e) {
      if (e && e.code === 'ENOENT') continue
      throw new Error(`source pi illisible (${f.abs}) : ${e && e.message}`)
    }
    const prev = prevFiles[f.rel]
    if (!uuidMigration && prev && prev.size === s.size && prev.mtimeMs === s.mtimeMs) unchanged.push([f.rel, s])
    else changed.push({ ...f, size: s.size, mtimeMs: s.mtimeMs })
  }

  // ── État reconstruit depuis les fichiers PRÉSENTS (D2) : les disparus
  // disparaissent de l'état (clé absente), les inchangés gardent leur entrée
  // (uuid propriétaire compris).
  const filesState = {}
  for (const [rel, s] of unchanged) filesState[rel] = { ...prevFiles[rel], size: s.size, mtimeMs: s.mtimeMs }

  // ── Invariant un-UUID-un-fichier, contrôle INTER-PASSES : les uuids des
  // fichiers inchangés sont connus de l'état ; tout uuid d'un fichier
  // changé/neuf est confronté à ces propriétaires ET aux uuids déjà
  // revendiqués dans la passe. Collision = échec avant toute publication.
  const uuidOwner = new Map() // uuid → relPath propriétaire
  if (!uuidMigration) {
    for (const [rel] of unchanged) {
      const u = prevFiles[rel] && prevFiles[rel].uuid
      if (u) uuidOwner.set(u, rel)
    }
  }
  const claimUuid = (uuid, rel) => {
    const owner = uuidOwner.get(uuid)
    if (owner && owner !== rel) {
      throw new Error(`invariant un-UUID-un-fichier violé : la session ${uuid} apparaît dans deux fichiers (${owner} et ${rel}) — échec avant toute publication, corpus et état inchangés`)
    }
    uuidOwner.set(uuid, rel)
  }

  // ── Lecture et mapping des fichiers changés, ordre stable (relPath) ──
  const bySession = new Map() // sessionId → { session, events, rawOutputs, orphans }
  const ignoredTotals = Object.create(null) // comptage sûr pour tout type source (__proto__…)
  for (const f of changed) {
    let dec
    try {
      dec = decodePiFile(f.abs, f.rel, piDir)
    } catch (e) {
      if (e && e.code === 'ENOENT') continue // disparu entre stat et lecture : ignoré
      throw e // JSON invalide / illisible : déjà contextualisé (chemin + ligne)
    }
    if (dec.session) {
      // Invariant UN-UUID-UN-FICHIER (design D4 amendé) : un UUID de session
      // identifie exactement un fichier source — contrôle INTER-PASSES (uuids
      // des fichiers inchangés de l'état) ET intra-passe, via claimUuid.
      // Deux fichiers déclarant le même UUID = échec explicite — JAMAIS de
      // fusion partielle (titre, métriques et en-tête seraient autrement
      // republiés incomplets).
      claimUuid(dec.session.id.slice(3), f.rel) // uuid brut (les clés du map sont sans préfixe)
      bySession.set(dec.session.id, {
        rel: f.rel,
        session: dec.session,
        events: dec.events,
        rawOutputs: dec.rawOutputs,
        orphans: dec.orphans
      })
    }
    // acquit : stat APRÈS lecture (D2) ; disparu pendant la lecture → pas
    // d'acquit (le fichier n'entre pas dans l'état).
    let st2
    try { st2 = fs.statSync(f.abs) } catch (e) {
      if (e && e.code === 'ENOENT') continue
      throw new Error(`source pi illisible (${f.abs}) : ${e && e.message}`)
    }
    filesState[f.rel] = {
      size: Math.min(dec.ack, f.size),
      mtimeMs: st2.mtimeMs,
      uuid: dec.session ? dec.session.id.slice(3) : null // null = fichier sans session (titre seul)
    }
    for (const k of Object.keys(dec.ignored)) ignoredTotals[k] = (ignoredTotals[k] || 0) + dec.ignored[k]
  }

  // ── Émission : sessions triées par id, événements triés (ts, id) par session,
  // lots émis au fil de la finalisation (callback immédiat quand fourni).
  const orphans = []
  const batches = onBatch ? null : []
  let buf = { sessions: [], events: [], rawOutputs: [] }
  const flush = () => {
    const b = buf
    buf = { sessions: [], events: [], rawOutputs: [] }
    if (b.sessions.length || b.events.length || b.rawOutputs.length) {
      if (typeof onBatch === 'function') onBatch(b)
      else batches.push(b)
    }
  }
  for (const sid of [...bySession.keys()].sort()) {
    const slot = bySession.get(sid)
    slot.events.sort(evSort) // ordre canonique (ts, id) — jamais l'ordre fichier
    orphans.push(...slot.orphans)
    buf.sessions.push(slot.session)
    buf.rawOutputs.push(...slot.rawOutputs)
    for (const ev of slot.events) {
      buf.events.push(ev)
      if (buf.events.length >= batchSize) flush() // session géante : découpe au fil des événements
    }
    flush() // chaque session finalisée est envoyée dès que possible
  }
  flush()

  return {
    files: filesState,
    orphans,
    ignored: ignoredTotals,
    acked: filesState,
    ...(typeof onBatch === 'function' ? {} : { batches })
  }
}
