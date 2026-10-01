// Constantes du contrat MCP (lot M1a).
//
// Plafonds de conception fixés par le design add-mcp-server (D2/D3/D10) : ils ne
// doivent jamais être changés silencieusement. Ce module ne contient ni serveur,
// ni handler, ni accès disque.

/** Écoute exclusive loopback (design D1). Aucune autre adresse n'est admise. */
export const MCP_HOST = '127.0.0.1'
export const MCP_PORT = 18767

// ── Budget global de réponse (D3) ──
// 524 288 octets de réponse MCP sérialisée UTF-8, enveloppe et curseurs compris.
export const RESPONSE_BUDGET_BYTES = 524288

// ── Plafonds search (D2/D3) ──
export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_HITS = 50
export const MAX_SEARCH_CTX = 5

// ── Plafonds read (D2/D3) ──
// 20 000 POINTS DE CODE de texte par message/fragment (unité du contrat M1a).
export const MAX_READ_MESSAGES = 200
export const MAX_READ_CTX = 50
export const MAX_READ_TAIL = 200
export const MAX_READ_CHARS = 20000

// ── Unités de fragmentation read (contrat M1a ; implémentation = M3) ──
// Offsets en POINTS DE CODE Unicode, `end` EXCLU ; encodage de la charge UTF-8.
export const READ_OFFSET_UNIT = 'unicode-code-point'
export const READ_TEXT_ENCODING = 'utf-8'

// ── Tailles de chaînes d'entrée (bornes d'implémentation, D2) ──
export const MAX_QUERY_CHARS = 512
export const MAX_FILTER_CHARS = 512
export const MAX_ROLE_CHARS = 64
export const MAX_SOURCE_CHARS = 64
export const MAX_BOUND_CHARS = 64

// ── Curseur read (D7) ──
// Borne de taille d'entrée seulement : la validation authentifiée du curseur
// (liaison outil/requête/génération) relève de M3 et n'est pas livrée ici.
export const MAX_CURSOR_CHARS = 2048

// ── Transport HTTP (lot M1b) ──
/** Route unique du service (toute autre route est refusée). */
export const MCP_ROUTE = '/mcp'
/** Plafond du corps de requête lu avant toute analyse (600 k octets refusés). */
export const MAX_BODY_BYTES = 262144
/** Plafond d'en-têtes HTTP (au-delà, Node répond 431 sans écho). */
export const MAX_HEADER_BYTES = 16384
/** Ports loopback admis dans Host/Origin (le port attendu est celui d'écoute). */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]'])
/** Identifiant JSON-RPC : entier sûr ≥ 0 ou chaîne technique ASCII bornée. */
export const MAX_ID_STRING_CHARS = 128
/** Longueur maximale d'un jeton statique (hors espaces, ASCII imprimable). */
export const MAX_TOKEN_CHARS = 4096
export const MCP_SERVER_NAME = 'session-dig'
export const MCP_SERVER_VERSION = '0.0.0'

/** Epoch ms maximal représentable par une date JS (bornage d'entrée). */
export const MAX_DATE_EPOCH_MS = 8.64e15