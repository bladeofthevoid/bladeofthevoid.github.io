/**
 * gateway/gateway.js
 * -----------------------------------------------------------------------
 * Entry point for the gateway. Per the architecture brief, this process:
 *   - Accepts the initial player connection
 *   - Maintains the world registry (gateway/WorldRegistry.js)
 *   - Tracks world populations (via world-server heartbeats)
 *   - Assigns players to worlds (gateway/AssignmentService.js)
 *   - Redirects clients (sends an endpoint, then disconnects them)
 *
 * The gateway does NOT simulate gameplay: there is no World, no
 * EntityManager, no MovementSystem, and no per-tick loop anywhere in this
 * file or in WorldRegistry/AssignmentService. Its entire job ends the
 * moment it has told a client which world server to talk to.
 *
 * Run with:  node gateway/gateway.js
 * Then open: http://localhost:9000  (GATEWAY_PORT env var to change)
 *
 * Client flow (see index.html's NetworkManager/Game for the other side):
 *   1. Client opens a WebSocket to the gateway, optionally with
 *      ?type=destination|hunt|cleansing|extraction|pvp (defaults to
 *      Config.DEFAULT_WORLD_TYPE if omitted/invalid).
 *   2. Gateway assigns a (server, world) pair and sends ONE message:
 *      { type: 'redirect', serverId, worldId, worldType, wsUrl, tickRate }
 *   3. Gateway closes the socket. The client then opens a NEW WebSocket
 *      directly to `${wsUrl}?worldId=${worldId}` -- that connection talks
 *      to the world server, not the gateway, for the rest of the session.
 * -----------------------------------------------------------------------
 */

const http = require('http');
const path = require('path');

const Config = require('../config/constants');
const MessageTypes = require('../network/MessageTypes');
const GameWebSocketServer = require('../network/WebSocketServer');
const { serveIndexIfRoot } = require('../shared/staticServer');
const { readJsonBody, sendJson } = require('../shared/httpJson');

const WorldRegistry = require('./WorldRegistry');
const AssignmentService = require('./AssignmentService');

const PORT = Config.GATEWAY.PORT;
const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

const registry = new WorldRegistry();
const assignmentService = new AssignmentService(registry);

// Keep world servers alive on Render's free plan: the gateway gets player
// traffic so it self-wakes, but world servers need explicit pings.
// Configure WORLD_SERVER_URLS on the gateway's Render env (comma-separated
// list of world-server admin base URLs) — see config/constants.js for docs.
registry.startKeepAlive(Config.KEEP_ALIVE.WORLD_SERVER_URLS);

// -------------------------------------------------------------------------
// HTTP: static index.html (the client's entry point, per the architecture
// diagram CLIENT -> Gateway) + the registration/heartbeat API world
// servers use to announce themselves and their populations.
// -------------------------------------------------------------------------
const httpServer = http.createServer(async (req, res) => {
  if (serveIndexIfRoot(req, res, INDEX_HTML_PATH)) return;

  if (req.method === 'POST' && req.url === '/gateway/register') {
    try {
      const body = await readJsonBody(req);
      registry.registerServer(body);
      console.log(`[gateway] registered server ${body.serverId} (${body.wsUrl})`);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'Malformed registration body.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/gateway/heartbeat') {
    try {
      const body = await readJsonBody(req);
      registry.updateHeartbeat(body);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: 'Malformed heartbeat body.' });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/gateway/status') {
    sendJson(res, 200, registry.getStatusSnapshot());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// -------------------------------------------------------------------------
// WebSocket: the client's very first connection of a session lands here.
// It never receives gameplay data -- only ever a redirect or an error.
// -------------------------------------------------------------------------
const wsServer = new GameWebSocketServer(httpServer);

wsServer.onConnect = async (id, query) => {
  let assignment;
  try {
    assignment = await assignmentService.assign({ type: query.type });
  } catch (err) {
    assignment = null;
  }

  if (!assignment) {
    wsServer.send(id, {
      type: MessageTypes.S2C_ASSIGNMENT_ERROR,
      reason: 'No world server currently has room. Please try again shortly.',
    });
    wsServer.close(id, 1013, 'no capacity');
    return;
  }

  wsServer.send(id, { type: MessageTypes.S2C_REDIRECT, ...assignment });
  console.log(`[gateway] assigned ${id} -> ${assignment.serverId}/${assignment.worldId}`);

  // Give the send() a moment to actually flush over the socket before
  // closing it -- `ws` queues the write, but closing the instant after
  // calling send() has been known to race the underlying TCP write on
  // some platforms. 50ms is comfortably more than that ever takes.
  setTimeout(() => wsServer.close(id, 1000, 'redirected'), 50);
};

wsServer.onMessage = () => {
  // The gateway has nothing to do with any message a client might send
  // before being redirected (e.g. a stray ping) -- it only ever acts on
  // the connection event itself.
};

httpServer.listen(PORT, () => {
  console.log(`[gateway] listening on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('[gateway] shutting down...');
  registry.shutdown();
  httpServer.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
