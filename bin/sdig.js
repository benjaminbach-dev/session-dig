#!/usr/bin/env node
// sdig — archéologie de sessions opencode (corpus JSONL canonique + BM25/FTS5).
// change scale-corpus : corpus v2 (shards par session), vue dérivable = chemin de
// lecture unique, preuves brutes shardées et lues par blocs, empreinte, migration.
import { ingest, migrate, fingerprint, proofWarning, recover } from '../src/corpus.js'
import { index, search, searchChrono, browseChrono } from '../src/retriever/bm25.js'
import { corpusPaths, sourceDb, sourcePi, corpusRoot } from '../src/paths.js'
import { openView, viewPath, viewIsCurrent, inReadTx, checkFresh, sourceStatesOf, piTokenOf } from '../src/view.js'
import { rawShardPath } from '../src/layout.js'
import { renderTerminal, renderJson, renderStatus, renderFingerprint, renderChrono } from '../src/format.js'
import { parseDateBound, streamBytes } from '../src/util.js'
import { neighborsBySessionDb } from '../src/read.js'
import { rawScan, openProofFd } from '../src/raw.js'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const USAGE = `sdig — archéologie de sessions opencode

Usage:
  sdig <requête> [--sort relevance|oldest|newest] [filtres]
                                recherche (commande par défaut) ; --sort oldest|newest
                                sélectionne TOUS les matches filtrés puis les ordonne
                                chronologiquement (ts, id) avant --limit ; sans requête
                                positionnelle, explore les messages user/assistant filtrés
  sdig read <session> [--around <msgId>] [--ctx N] [--tail N] [--at <ancre>] [--full | --chars N] [--json]
                                dérouler une session autour d'un message, éventuellement
                                bornée dans le temps (--at : id de message, date, ou epoch ms)
  sdig raw <partId>            afficher une sortie d'outil brute (preuve, lecture par blocs ;
                               durée et volume affichés sur stderr, jamais dans stdout)
  sdig ingest [--db P] [--rebuild] [--recover]
                                source → corpus (incrémental par défaut ; --recover :
                                reprise explicite sans source, décision d'opérateur)
  sdig migrate                 corpus v1 → layout v2, sans la source (en flux, vérifiée)
  sdig fingerprint             empreinte déterministe du corpus (md5 agrégé, chemins triés)
  sdig index                   corpus → vue/index BM25 (rebuild complet)
  sdig refresh                 ingest + index
  sdig status                  état du corpus et de la vue
  sdig mcp [--home P] [--db P] [--pi-dir P]
                                serveur MCP local (Streamable HTTP, lecture seule) :
                                écoute 127.0.0.1:18767/mcp, arrêt par Ctrl-C ;
                                jeton optionnel via env SESSION_DIG_MCP_TOKEN (jamais affiché)

Filtres de recherche :
  --repo R       repo exact (basename du répertoire de session)
  --session S    id de session (préfixe accepté, ex. pi:01a0…)
  --source S     provenance exacte : all (défaut) | opencode | pi — filtre les hits
                 (titres compris) et borne le scan --raw ; source inconnue = zéro hit
  --after DATE   à partir de (2026, 2026-06, 2026-06-01 ou ISO)
  --before DATE  jusqu'à (incluse)
  --model M      sous-chaîne (ex: deepseek, opencode/big-pickle)
  --role R       user | assistant
  --agent A      agent exact (build, plan...)
  --limit N      défaut 20
  --ctx N        affiche N messages voisins autour de chaque hit (lecture du contexte)
  --sort MODE    tri de la recherche : relevance (défaut, BM25 STRICTEMENT inchangé),
                 oldest ou newest. En oldest/newest, la sélection porte sur l'ENSEMBLE
                 des matches filtrés puis l'ordre (ts, id binaire) précède --limit ; la
                 requête positionnelle est optionnelle (mode exploration user/assistant).
                 Une requête fournie vide/en espaces/stopwords suit la normalisation
                 existante ; omission PHYSIQUE seule = exploration. Refusé hors recherche
                 et avec --raw ; la métadonnée de modèle absente n'est jamais inventée
                 (model: null, avertissement conditionnel sur stderr en --json).
  --at ANCRE     (read) borne la lecture à un instant : masque les messages postérieurs
                 à l'ancre (id de message de la session, AAAA-MM-JJ[THH:MM] en UTC, ou
                 epoch ms ; une date seule garde la journée entière visible). Un horodatage
                 à la minute se place à :00 de cette minute — pour viser un message précis,
                 donner son id ou son epoch ms. Horodatage calendairement valide exigé —
                 2026-02-30 ou 25:00 sont refusés, jamais reportés en silence ; ancre vide
                 = erreur. L'ancre est rappelée et le nombre de messages masqués est
                 affiché (jamais de masquage silencieux).
                 Hors périmètre : aucune détection des changements d'état.
  --raw          cherche aussi dans les sorties brutes (stderr inclus ; scan en flux
                 par blocs — coût O(volume de raw/), durée affichée sur stderr ; borné
                 par --source ; non combiné avec --json, qui rend les hits seuls)
  --full         texte intégral des messages (lève la limite d'affichage ; read, --ctx, hits)
  --chars N      limite d'affichage par message en caractères (défaut : 400 + 4 lignes)
  --json         sortie JSON (script/tests ; texte intégral des messages dans le champ text)
  --plain        highlight sans ANSI

Sources (change add-pi-adapter) :
  --source S     sur ingest/refresh : all (défaut) ingère les sources présentes,
                 les absentes sont signalées ; opencode|pi explicite : la source
                 demandée absente est une erreur
  --pi-dir P     répertoire des sessions pi (défaut ~/.pi/agent/sessions,
                 env SESSION_DIG_PI_DIR) — lecture seule stricte ; les orphelines
                 pi sont lisibles par \`sdig raw pi:<sessionId>:<id>\`

Global :
  --home P       racine corpus (défaut ~/.local/share/session-dig, env SESSION_DIG_HOME)
  --db P         base opencode UNIQUEMENT (défaut ~/.local/share/opencode/opencode.db,
                 env SESSION_DIG_DB) — jamais appliquée à la source pi`

const MCP_USAGE = `sdig mcp — serveur MCP local (Streamable HTTP, lecture seule)

Usage:
  sdig mcp [--home P] [--db P] [--pi-dir P]

Écoute EXCLUSIVE 127.0.0.1:18767, route /mcp. Aucun autre transport, aucune
installation, aucun autostart : lancement et arrêt MANUELS (Ctrl-C / SIGTERM).

  --home P     racine corpus (défaut ~/.local/share/session-dig, env SESSION_DIG_HOME)
  --db P       base opencode (défaut env SESSION_DIG_DB ou emplacement usuel)
  --pi-dir P   répertoire des sessions pi (défaut env SESSION_DIG_PI_DIR ou ~/.pi/agent/sessions)
  --help       cette aide

Jeton optionnel : variable d'environnement SESSION_DIG_MCP_TOKEN (jamais affichée).
Sans jeton, aucun client local n'est authentifié (loopback n'est PAS une authentification).
Aucun argument positionnel n'est admis ; toute autre option est refusée.`

function fail (msg, code = 1) {
  console.error(`sdig: ${msg}`)
  process.exit(code)
}

// Bilan pi (add-pi-adapter) : fichiers suivis, orphelins (partIds), lignes
// ignorées par TYPE/COMPTE — jamais le contenu des lignes (D6).
function printPiSummary (pi) {
  console.log(`  pi : ${pi.files} fichier(s) suivi(s), ${pi.orphans.length} exécution(s)/résultat(s) non rattaché(s)`)
  const ignored = Object.entries(pi.ignored || {})
  if (ignored.length) {
    console.log(`    lignes ignorées : ${ignored.map(([type, n]) => `${type}=${n}`).join(', ')}`)
  }
  for (const partId of pi.orphans) console.log(`    orphelin : ${partId}`)
}

function parseArgs (argv) {
  const positional = []
  const flags = {}
  const known = new Set(['repo', 'session', 'after', 'before', 'model', 'role', 'agent', 'limit', 'json', 'plain', 'home', 'db', 'rebuild', 'ctx', 'raw', 'around', 'tail', 'at', 'head', 'full', 'chars', 'recover', 'source', 'pi-dir', 'sort'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { flags.help = true; continue }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      // Spec search : l'option inconnue est NOMMÉE dans l'erreur (parcours CLI général).
      if (!known.has(k)) fail(`option inconnue : ${a}\n\n${USAGE}`)
      if (k === 'json' || k === 'plain' || k === 'rebuild' || k === 'raw' || k === 'full' || k === 'recover') { flags[k] = true; continue }
      // `--sort` : valeur MANQUANTE si fin d'arguments OU option suivante — ne JAMAIS
      // consommer l'option suivante (`--sort --limit 1` ne doit pas avaler --limit).
      if (k === 'sort') {
        const v = argv[i + 1]
        if (v == null || v.startsWith('-')) fail('option --sort : valeur manquante (relevance|oldest|newest)')
        flags.sort = v
        i++
        continue
      }
      const v = argv[++i]
      if (v == null) fail(`option ${a} : valeur manquante`)
      flags[k] = v
    } else positional.push(a)
  }
  return { positional, flags }
}

function parseChars (flags) {
  if (!flags.chars) return null
  const n = parseInt(flags.chars, 10)
  if (!Number.isFinite(n) || n < 1) fail('--chars : nombre invalide')
  return n
}

// ── sdig mcp : parser DÉDIÉ FERMÉ + lancement manuel (lot M4) ────────────────
// Seules --home/--db/--pi-dir/--help sont admises. AUCUN argument (nom d'option,
// valeur ou positionnel) n'est recopié dans les erreurs : un flag arbitraire peut
// transporter un secret. Le token n'a PAS de flag : uniquement l'env
// SESSION_DIG_MCP_TOKEN, jamais affiché. Intercepté AVANT le parser général et le
// contrôle `--at` (qui ne concernent pas ce dispatch).
function parseMcpArgs (args) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') { flags.help = true; continue }
    if (a === '--home' || a === '--db' || a === '--pi-dir') {
      const v = args[i + 1]
      // Refus d'une valeur ABSENTE, VIDE ou qui est en fait l'option suivante
      // (`--home --port`) : sinon un flag inconnu serait avalé et le service
      // pourrait démarrer sur 18767 au lieu d'être refusé. Un chemin commençant
      // par `-` doit être donné en absolu ou préfixé `./`.
      if (v == null || v === '' || v.startsWith('-')) fail('mcp : valeur manquante ou invalide pour une option admise')
      i++
      flags[a.slice(2)] = v
      continue
    }
    if (a.startsWith('-')) fail('mcp : option non reconnue (admises : --home, --db, --pi-dir, --help)')
    fail('mcp : aucun argument positionnel admis')
  }
  return flags
}

async function runMcp (args) {
  const flags = parseMcpArgs(args)
  if (flags.help) { console.log(MCP_USAGE); return }
  if (flags.home) process.env.SESSION_DIG_HOME = flags.home
  if (flags.db) process.env.SESSION_DIG_DB = flags.db
  if (flags['pi-dir']) process.env.SESSION_DIG_PI_DIR = flags['pi-dir']
  const paths = corpusPaths(corpusRoot())

  // Import/config/start : TOUTE erreur est convertie en message FIXE (jamais
  // `e.message`) ; seuls des codes errno d'écoute PINNÉS sont repris.
  let createApp, launchErrorMessage, installAppShutdown
  try {
    ({ createApp, launchErrorMessage, installAppShutdown } = await import('../src/mcp/app.js'))
  } catch {
    fail('mcp : module d’application indisponible')
  }
  let app
  try {
    app = createApp({ root: paths.root, db: flags.db, piDir: flags['pi-dir'] })
  } catch {
    fail('mcp : configuration refusée (token ou options invalides)')
  }
  try {
    await app.server.start()
  } catch (e) {
    fail(launchErrorMessage(e))
  }

  // Arrêt partagé (close→dispose→exit) installé AVANT l'annonce d'écoute : aucune
  // course observable entre le signal et l'enregistrement du handler.
  installAppShutdown(app)
  const addr = app.server.address()
  const tokenSet = !!(process.env.SESSION_DIG_MCP_TOKEN)
  console.error(`sdig mcp : écoute ${addr.host}:${addr.port}/mcp — ${tokenSet ? 'jeton requis' : 'sans authentification (loopback uniquement)'}`)
  await new Promise(() => {}) // reste actif jusqu'au signal ; aucun travail détaché
}

function loadSessions (db, sessionIds = null) {
  // sessions des hits SEULEMENT en chemin de commande (passe corrective 20/09) :
  // charger TOUTES les sessions pour un rendu groupé coûtait O(#sessions) en mémoire.
  const rows = sessionIds && sessionIds.length
    ? db.prepare(`SELECT id, json FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(',')})`).all(...sessionIds)
    : db.prepare('SELECT id, json FROM sessions').all()
  const sessions = rows.map(r => JSON.parse(r.json))
  return { sessionsById: new Map(sessions.map(s => [s.id, s])) }
}

async function main () {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); return }

  // `sdig mcp` : parser dédié FERMÉ, intercepté AVANT le parser général et `--at`.
  if (argv[0] === 'mcp') { await runMcp(argv.slice(1)); return }

  const sub = argv[0]
  const isSub = ['ingest', 'index', 'refresh', 'status', 'read', 'raw', 'migrate', 'fingerprint'].includes(sub)
  const { positional, flags } = parseArgs(isSub ? argv.slice(1) : argv)

  // --sort (change add-cli-chronological-sort) : option de la RECHERCHE CLI uniquement.
  // `mcp` a son parser dédié FERMÉ (refus fixe sans écho) intercepté plus haut. Valeur
  // inconnue et option sur sous-commande sont refusées EXPLICITEMENT ; l'omission =
  // relevance. `--sort relevance` sans requête échoue (aucune requête `'*'` inventée).
  if (flags.sort !== undefined) {
    if (!['relevance', 'oldest', 'newest'].includes(flags.sort)) fail('--sort : valeur inconnue (relevance|oldest|newest)')
    if (isSub) fail(`--sort : option de la recherche uniquement (refusée pour « ${sub} »)`)
  }

  // --at (change add-read-at) n'existe que sur la lecture : la recherche borne par date
  // avec --after/--before, elle ne masque pas d'affichage.
  if (flags.at && !(isSub && sub === 'read')) {
    fail('--at : option de `sdig read` uniquement (pour la recherche, voir --after/--before)')
  }

  if (flags.home) process.env.SESSION_DIG_HOME = flags.home
  if (flags.db) process.env.SESSION_DIG_DB = flags.db
  if (flags['pi-dir']) process.env.SESSION_DIG_PI_DIR = flags['pi-dir']
  // add-pi-adapter (D3) : la valeur de --source est validée au registre du cœur
  // (source inconnue → erreur dédiée) ; ici on la transmet telle quelle.
  const sourceFlag = flags.source
  const piDirFlag = flags['pi-dir']
  const paths = corpusPaths(corpusRoot())

  if (isSub && sub === 'ingest') {
    if (flags.recover) {
      const r = recover(paths.root)
      console.log(r.note)
      if (!r.done) process.exit(1)
      return
    }
    const r = await ingest({ root: paths.root, db: flags.db, piDir: piDirFlag, source: sourceFlag, rebuild: flags.rebuild })
    console.log(`ingest ${r.rebuild ? '(rebuild)' : '(incrémental)'} : +${r.added} events (${r.updated} maj, ${r.unchanged} inchangés), +${r.sessionsAdded} sessions (${r.sessionsUpdated} maj) → ${r.totals.events} events / ${r.totals.sessions} sessions, ${r.rawWritten} raw écrit(s), ${r.shardsTouched} shard(s) touché(s)`)
    // add-pi-adapter : résumé multi-source (absences, invalidations, migration, orphelins)
    for (const n of r.notes || []) console.log(`  ${n}`)
    if (r.pi) {
      printPiSummary(r.pi)
    }
    return
  }

  if (isSub && sub === 'migrate') {
    const r = await migrate(paths.root)
    console.log(r.note)
    process.exit(r.done ? (r.coherent === false ? 1 : 0) : 1)
  }

  if (isSub && sub === 'fingerprint') {
    const f = fingerprint(paths.root)
    console.log(renderFingerprint(f))
    return
  }

  if (isSub && sub === 'index') {
    if (!fs.existsSync(paths.sessions)) fail('corpus absent — lancer `sdig ingest` d\'abord')
    const r = index(paths.root)
    console.log(`index bm25 : ${r.events} event(s) indexé(s) → ${r.dbFile}`)
    return
  }

  if (isSub && sub === 'refresh') {
    const r1 = await ingest({ root: paths.root, db: flags.db, piDir: piDirFlag, source: sourceFlag, rebuild: flags.rebuild })
    const r2 = index(paths.root)
    console.log(`refresh : +${r1.added}/${r1.updated} events → corpus ${r1.totals.events}, vue/index ${r2.events}`)
    for (const n of r1.notes || []) console.log(`  ${n}`)
    if (r1.pi) {
      printPiSummary(r1.pi)
    }
    return
  }

  if (isSub && sub === 'status') {
    let st
    try { st = JSON.parse(fs.readFileSync(paths.state, 'utf8')) } catch { fail('corpus absent — lancer `sdig ingest` d\'abord') }
    let rawFiles = 0
    try { rawFiles = fs.readdirSync(paths.raw, { recursive: true }).filter(f => f.endsWith('.txt')).length } catch {}
    let view = null
    let viewNote = null
    const viewDbFile = viewPath(paths.root)
    if (!fs.existsSync(viewDbFile)) {
      viewNote = null // renderStatus : « absente (lancer sdig refresh) »
    } else if (!viewIsCurrent(paths.root)) {
      viewNote = 'périmée (forme ou version antérieure — lancer sdig refresh)'
    } else {
      // fraîcheur per-source VUE vs ÉTAT PUBLIÉ — JAMAIS contre les fichiers
      // sources vivants : un fichier pi qui grandit entre deux refresh ne rend
      // pas la vue indisponible (revue finale, bug B)
      const vdb = new Database(viewDbFile, { readonly: true })
      try {
        const fresh = checkFresh(paths.root, { db: vdb })
        if (!fresh.fresh) {
          const cause = String(fresh.reason || '').replace(/ — lancer `sdig refresh`$/, '')
          viewNote = `périmée (${cause})`
        } else {
          view = { events: vdb.prepare("SELECT COUNT(*) n FROM events WHERE role != 'title'").get().n, mtime: fs.statSync(viewDbFile).mtimeMs }
        }
      } finally { vdb.close() }
    }
    const counts = st.counts || { sessions: 0, events: 0 }
    // add-pi-adapter (D3) : watermarks PAR SOURCE, absences signalées sans erreur —
    // le chemin CONFIGURÉ (flag --pi-dir / env / défaut) fait foi pour l'absence
    // et le re-pointage, l'état publié pour le bilan des fichiers suivis.
    // Bug A (revue finale) : normaliser la forme PLATE héritée (source/message/
    // session au top-level) — sinon opencode était déclarée « absente » alors que
    // ses watermarks existent dans le state plat et que la base est présente.
    const normSources = sourceStatesOf(st)
    const piConfigured = sourcePi()
    const ocConfigured = sourceDb(flags.db)
    const ocState = normSources.opencode
    const piState = normSources.pi
    // présence : seul ENOENT = absent ; une erreur d'accès (EACCES…) est signalée
    // comme telle, jamais avalée en absence (revue étape 2, appliquée au status)
    const presence = (p) => {
      try { fs.statSync(p); return 'ok' } catch (e) {
        return e && e.code === 'ENOENT' ? 'absent' : `illisible (${e && e.message})`
      }
    }
    // opencode : epoch réel de l'état ; source jamais ingérée → absence réelle,
    // jamais un watermark 0/0 trompeur (revue étape 3)
    const watermark = ocState
      ? { message: ocState.message ?? 0, session: ocState.session ?? 0 }
      : null
    console.log(renderStatus({ counts, rawFiles, layout: st.layoutVersion, watermark, view, viewNote, ocPath: ocConfigured, ocMissing: !ocState }, paths))
    if (piState) {
      console.log(`pi       : ${Object.keys(piState.files || {}).length} fichier(s) suivi(s), jeton ${String(piState.token || '').slice(0, 8)}`)
      if (piState.path && piState.path !== piConfigured) {
        console.log(`⚠ source pi re-pointée : ${piState.path} → ${piConfigured} — prochaine ingestion : invalidation de cette source seule`)
      }
    } else if (presence(piConfigured) === 'ok') {
      console.log(`pi       : pas encore ingérée (${piConfigured})`)
    } else if (presence(piConfigured) === 'absent') {
      console.log(`pi       : absente — ignorée (${piConfigured})`)
    } else {
      console.log(`⚠ source pi illisible : ${piConfigured} — ${presence(piConfigured)}`)
    }
    if (!fs.existsSync(piConfigured)) {
      console.log(`⚠ source pi configurée introuvable : ${piConfigured} — prochaine ingestion : absence signalée, état conservé`)
    }
    const ocPresence = ocState ? presence(ocState.path ?? ocConfigured) : presence(ocConfigured)
    if (!ocState) {
      if (ocPresence === 'absent') {
        console.log(`⚠ source opencode configurée introuvable : ${ocConfigured} — prochaine ingestion : absence signalée, état conservé`)
      } else if (ocPresence !== 'ok') {
        console.log(`⚠ source opencode illisible : ${ocConfigured} — ${ocPresence}`)
      }
    } else if (ocPresence === 'absent') {
      console.log(`⚠ base opencode disparue depuis l'ingestion : ${ocState.path} — prochaine ingestion : absence signalée, état conservé`)
    } else if (ocPresence !== 'ok') {
      console.log(`⚠ base opencode illisible : ${ocState.path} — ${ocPresence}`)
    }
    // info (pas une indisponibilité) : la source pi a évolué depuis le dernier
    // refresh — c'est l'état normal entre deux passes (revue finale, bug B)
    if (piState && presence(piConfigured) === 'ok') {
      try {
        const cur = {}
        const walkPi = (dir, rel) => {
          let entries
          try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (e.name.startsWith('.')) continue
            const abs = path.join(dir, e.name)
            const r = rel ? `${rel}/${e.name}` : e.name
            if (e.isDirectory()) walkPi(abs, r)
            else if (e.isFile() && e.name.endsWith('.jsonl')) {
              const s = fs.statSync(abs)
              cur[r] = { size: s.size, mtimeMs: s.mtimeMs }
            }
          }
        }
        walkPi(piConfigured, '')
        if (piTokenOf(cur) !== piState.token) {
          console.log('ℹ source pi a évolué depuis le dernier refresh — lancer sdig refresh')
        }
      } catch { /* diagnostic seul : jamais bloquant */ }
    }
    const warn = proofWarning(paths.root)
    if (warn) console.log(warn)
    return
  }

  if (isSub && sub === 'read') {
    const sessionId = positional[0]
    if (!sessionId) fail('usage : sdig read <session> [--around <msgId>] [--ctx N] [--tail N] [--at <ancre>] [--full | --chars N] [--json]')
    const chars = parseChars(flags)
    const { sessionSlice } = await import('../src/read.js')
    const { renderRead, renderReadJson } = await import('../src/format.js')
    let slice
    try {
      slice = sessionSlice(paths.root, sessionId, {
        aroundId: flags.around,
        ctx: flags.ctx ? parseInt(flags.ctx, 10) : 10,
        tail: flags.tail ? parseInt(flags.tail, 10) : undefined,
        at: flags.at
      })
    } catch (e) {
      fail(e.message) // vue absente/périmée : refus explicite, jamais un repli silencieux
    }
    if (!slice) fail(`session inconnue : ${sessionId} (préfixe accepté dans sdig --session, pas ici — id complet requis)`)
    // Ancre invalide : erreur explicite, sortie non nulle, aucune sortie partielle trompeuse.
    if (slice.fatal) fail(slice.error, 2)
    // Avertissement de publication (marqueur d'ingestion non réconcilié : une preuve
    // peut être en avance sur la vue) : en terminal il reste sur stdout, jamais perdu.
    // En --json, stdout SHALL rester UN document JSON valide — l'avertissement part
    // sur stderr (toujours visible), il n'est ni supprimé ni préfixé au JSON.
    const warn = proofWarning(paths.root)
    if (warn) {
      if (flags.json) console.error(warn)
      else console.log(warn)
    }
    if (flags.json) { console.log(renderReadJson(slice, sessionId)); return }
    console.log(renderRead(slice, sessionId, { full: !!flags.full, chars, plain: !!flags.plain }))
    return
  }

  if (isSub && sub === 'raw') {
    const partId = positional[0]
    if (!partId) fail('usage : sdig raw <partId> (id de part, cf. rawRef dans les résultats)')
    // add-pi-adapter (revue étape 3) : validation du partId AVANT dérivation de
    // chemin — familles connues uniquement (opencode hérité : un segment sans
    // ':' ; pi : pi:<sessionId>:<id local>, '|' licite dans l'id local), refus
    // des séparateurs de chemin, de la traversée '..', des ids vides, à blancs
    // en bord ou porteurs de caractères de contrôle.
    const ctl = /[\x00-\x1f\x7f]/
    const seg = (s) => typeof s === 'string' && s !== '' && s.trim() === s &&
      !ctl.test(s) && !s.includes('..') && !s.includes('/') && !s.includes('\\')
    if (partId.startsWith('pi:')) {
      const rest = partId.slice(3)
      const sep = rest.indexOf(':')
      if (sep < 0 || !seg(rest.slice(0, sep)) || !seg(rest.slice(sep + 1)) || rest.slice(sep + 1).includes(':')) {
        fail(`partId pi invalide : ${JSON.stringify(partId)} — forme attendue pi:<sessionId>:<id local>`)
      }
    } else if (!seg(partId) || partId.includes(':')) {
      // ':' est réservé à la famille pi ; l'hérité opencode n'en porte pas
      fail(`partId invalide : ${JSON.stringify(partId)}`)
    }
    // ouverture CONFINÉE (revue finale) : composantes sous raw/ vérifiées par
    // lstat (pas de lien symbolique), fichier ouvert puis validé par fstat — la
    // lecture part du fd ouvert, jamais d'une réouverture par chemin
    const opened = openProofFd(paths.raw, partId)
    if (opened.error) {
      fail(`preuve brute refusée (${opened.error}) : ${JSON.stringify(partId)}`)
    }
    const file = opened.file
    const warn = proofWarning(paths.root)
    if (warn) console.log(warn)
    // lecture par blocs bornés depuis le fd CONFINÉ (jamais de réouverture par
    // chemin) : l'empreinte mémoire ne dépend pas de la taille du fichier
    const t0 = performance.now()
    const bytes = streamBytes(opened.fd, (blk) => {
      let offset = 0
      while (offset < blk.length) offset += fs.writeSync(1, blk, offset, blk.length - offset)
    })
    fs.closeSync(opened.fd)
    // Durée/volume d'affichage de la preuve : mesure d'honnêteté, affichée PAR DÉFAUT
    // sur stderr — jamais dans stdout (les octets de la preuve y sont écrits tels
    // quels ; un appelant qui redirige stdout ne voit aucun décor supplémentaire).
    process.stderr.write(`  (${(performance.now() - t0).toFixed(0)} ms, ${bytes} o)\n`)
    return
  }

  // ── recherche (défaut) ──
  const sortMode = flags.sort ?? 'relevance'
  const chrono = sortMode === 'oldest' || sortMode === 'newest'
  const hasQuery = positional.length > 0
  const q = positional.join(' ')
  // relevance (défaut) STRICTEMENT inchangé : requête exigée. En chrono, seule
  // l'OMISSION PHYSIQUE de la requête ouvre l'exploration ; une requête fournie
  // vide/espaces/stopwords suit la normalisation existante (no_terms).
  if (!chrono && !q) fail('requête manquante\n\n' + USAGE)
  if (chrono && flags.raw) fail('--raw : incompatible avec --sort oldest|newest (classement chronologique et scan brut confondus refusés)')
  if (!fs.existsSync(viewPath(paths.root))) fail('index absent — lancer `sdig refresh` d\'abord')
  const after = flags.after ? parseDateBound(flags.after, false) : null
  const before = flags.before ? parseDateBound(flags.before, true) : null
  if (flags.after && after == null) fail(`--after : date invalide (${flags.after})`)
  if (flags.before && before == null) fail(`--before : date invalide (${flags.before})`)
  // Le nouveau mode exige un entier positif strict ; la conversion historique
  // de relevance reste inchangée (pas de changement de contrat du défaut).
  const limit = chrono && flags.limit != null ? Number(flags.limit) : (flags.limit ? parseInt(flags.limit, 10) : 20)
  if (!Number.isFinite(limit) || limit < 1 || (chrono && !Number.isSafeInteger(limit))) fail('--limit : nombre invalide')

  // UNE transaction de lecture pour TOUTE la commande (passe corrective 20/09,
  // revue) : hits, voisins, compteurs et métadonnées partagent UN snapshot —
  // partager une connexion ne suffisait pas, une publication concurrente pouvait
  // s'intercaler entre les requêtes.
  const db = openView(paths.root)
  try {
    const run = () => {
      // Après validation de la fraîcheur du snapshot : les preuves (--raw, hors
      // snapshot) peuvent être en avance sur la vue. En --json, seul stderr porte
      // l'avertissement ; stdout reste un unique document JSON.
      const warn = proofWarning(paths.root)
      if (warn) {
        if (flags.json) console.error(warn)
        else console.log(warn)
      }
      const filters = { repo: flags.repo, session: flags.session, after, before, model: flags.model, role: flags.role, agent: flags.agent, source: sourceFlag, limit }
      let hits
      if (chrono && hasQuery) {
        // Sélection GLOBALE des matches filtrés puis ordre (ts, id binaire) avant --limit.
        hits = searchChrono(db, { ...filters, q, sort: sortMode, plain: flags.plain || flags.json })
      } else if (chrono) {
        // Sans mots-clés : sous-ensemble canonique user/assistant, aucun MATCH FTS.
        hits = browseChrono(db, { ...filters, sort: sortMode })
      } else {
        hits = search(db, { ...filters, q, plain: flags.plain || flags.json })
      }
      // Mode chrono SANS mots-clés : la métadonnée de modèle absente n'est JAMAIS
      // inventée ; l'avertissement est CONDITIONNEL aux hits assistants RENDUS et
      // va sur stderr (stdout reste un unique tableau JSON en --json).
      if (chrono && !hasQuery) {
        const missing = hits.filter(h => h.role === 'assistant' && !h.model).length
        if (missing > 0) console.error(`⚠ modèle absent : ${missing} hit(s) assistant rendu(s) sans métadonnée de modèle (model: null, jamais inventé)`)
      }
      if (flags.json) { console.log(renderJson(hits)); return { hits, done: true } }
      if (!hits.length && !flags.raw) { console.log('aucun résultat'); return { hits, done: true } }
      const chars = parseChars(flags)
      const prettify = hits.map(h => ({ ...h, role: h.role === 'title' ? 'titre' : h.role }))
      if (hits.length) {
        let ctxBySession = null
        if (flags.ctx) {
          const n = parseInt(flags.ctx, 10)
          if (!Number.isFinite(n) || n < 0) fail('--ctx : nombre invalide')
          // voisins PAR CLÉ autour de chaque hit (requêtes bornées, même snapshot,
          // mémoire O(fenêtres) — jamais un tableau de la longueur de la session)
          const bySes = new Map()
          for (const h of hits) {
            if (!bySes.has(h.session_id)) bySes.set(h.session_id, [])
            bySes.get(h.session_id).push(h)
          }
          ctxBySession = new Map()
          for (const [sid, hs] of bySes) {
            ctxBySession.set(sid, neighborsBySessionDb(db, sid, hs, n).get(sid))
          }
        }
        const { sessionsById } = loadSessions(db, [...new Set(hits.map(h => h.session_id))])
        if (chrono) {
          // Rendu PLAT : l'ordre global et l'entrelacement des sessions sont préservés.
          console.log(renderChrono(prettify, sessionsById, { sort: sortMode, ctx: ctxBySession ? parseInt(flags.ctx, 10) : 0, ctxBySession, plain: flags.plain, full: !!flags.full, chars }))
        } else {
          console.log(renderTerminal(prettify, sessionsById, { ctx: ctxBySession ? flags.ctx : 0, ctxBySession, plain: flags.plain, full: !!flags.full, chars }))
        }
      }
      return { hits }
    }
    const { hits, done } = inReadTx(db, run, { root: paths.root })
    if (done) return
    if (flags.raw) {
      // scan --raw HORS snapshot : il lit les fichiers de preuve (contenu, pas la
      // vue) — coût O(raw/) documenté, durée affichée.
      const { renderRawHits } = await import('../src/format.js')
      const t0 = performance.now()
      const matches = rawScan(paths.root, q, { limit: 10, source: sourceFlag })
      const dt = performance.now() - t0
      if (matches.length) console.log(renderRawHits(matches))
      else if (!hits.length) console.log('aucun résultat (ni index, ni sorties brutes)')
      // Durée du scan affichée PAR DÉFAUT sur stderr (même sans match : le coût
      // O(raw/) a été payé) — stdout reste le rendu des hits, jamais pollué.
      console.error(`  scan raw : ${dt.toFixed(0)} ms`)
    }
  } finally {
    db.close()
  }
}

main().catch(e => fail(e.message))
