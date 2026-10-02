// Helper ENFANT : monte l'app MCP réelle sur un serveur ÉPHÉMÈRE (jamais 18767),
// annonce son port, puis s'arrête via la MÊME fonction partagée que le CLI
// (`installAppShutdown`). `FAIL_CLOSE=1` injecte une fermeture en échec (via la
// fabrique) pour vérifier le code de sortie 1 + diagnostic fixe.
import { createApp, installAppShutdown } from '../../src/mcp/app.js'
import { createMcpTestServer } from '../../src/mcp/server.js'

const serverFactory = process.env.FAIL_CLOSE === '1'
  ? (opts) => {
      const srv = createMcpTestServer(opts)
      const realClose = srv.close.bind(srv)
      srv.close = async () => { await realClose(); throw new Error('injection : fermeture en échec') }
      return srv
    }
  : createMcpTestServer

const app = createApp({
  root: process.env.ROOT,
  db: process.env.DB,
  piDir: process.env.PI,
  serverFactory,
  logger: () => {}
})
await app.server.start()

// Arrêt partagé installé AVANT l'annonce du port : aucune course signal/handler.
installAppShutdown(app)
process.stdout.write(`PORT ${app.server.address().port}\n`)
setInterval(() => {}, 1000)
