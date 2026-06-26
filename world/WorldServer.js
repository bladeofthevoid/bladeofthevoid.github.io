/**
 * world/WorldServer.js
 * -----------------------------------------------------------------------
 * Entry point for ONE world-hosting server instance (e.g. "FRA-01"). This
 * plays the same wiring role the original server.js played -- it is the
 * only place that knows about all the pieces (WorldManager, SnapshotManager
 * via World, the WebSocket layer, the gateway) -- but where the old
 * server.js owned exactly one global EntityManager/SimulationWorld, this
 * file owns a WorldManager that can host many fully isolated Worlds, per
 * the architecture brief: "Each server instance may host multiple
 * worlds. Do NOT hardcode one world per instance."
 *
 * Run with:  node world/WorldServer.js
 * Then open: http://localhost:8080  (PORT env var to change)
 *
 * Environment variables:
 *   SERVER_ID     - this instance's id, e.g. 'FRA-01' (default 'FRA-01')
 *   PORT          - HTTP/WS port for this instance (default 8080). On
 *                   Render and most PaaS hosts this is injected for you
 *                   and MUST be honored -- never hardcode a port.
 *   PUBLIC_HOST   - (local/manual deployments only) hostname clients/the
 *                   gateway should use to reach this instance when
 *                   there's no TLS-terminating proxy in front of it
 *                   (default 'localhost'). Ignored if PUBLIC_BASE_URL or
 *                   RENDER_EXTERNAL_URL is set.
 *   PUBLIC_BASE_URL - explicit override for this instance's externally
 *                   reachable base URL, e.g. 'https://fra-01.example.com'.
 *                   Use this for any deployment behind HTTPS that isn't
 *                   Render (Render is auto-detected, see below).
 *   GATEWAY_URL   - base URL of the gateway to register/heartbeat with
 *                   (default http://localhost:9000). Registration and
 *                   heartbeats are best-effort: this server runs fine
 *                   standalone (no gateway) for local development,
 *                   exactly like the original single-server foundation.
 *
 * Render-specific note: Render automatically sets RENDER_EXTERNAL_URL to
 * this service's public https://*.onrender.com URL. This file picks that
 * up with zero configuration -- you do not need to set PUBLIC_HOST or
 * PUBLIC_BASE_URL when deploying to Render. See MIGRATION.md for a full
 * Render + GitHub Pages deployment walkthrough.
 *
 * Responsibilities (per the architecture brief):
 *   - Simulate worlds        -> WorldManager + SimulationLoop + World.update()
 *   - Maintain player state  -> World.players / World.entityManager
 *   - Run networking         -> GameWebSocketServer (unchanged wrapper)
 *   - Run snapshots           -> World.buildSnapshot(), broadcast per-world below
 *   - Combat-ready infra      -> interfaces/HookRegistry.js wired into every World
 * -----------------------------------------------------------------------
 */

const http = require('http');
const path = require('path');

const Config = require('../config/constants');
const MessageTypes = require('../network/MessageTypes');
const GameWebSocketServer = require('../network/WebSocketServer');
const { serveStatic } = require('../shared/staticServer');
const { postJson, readJsonBody, sendJson } = require('../shared/httpJson');

const WorldManager = require('./WorldManager');
const SimulationLoop = require('./SimulationLoop');
const PersistenceManager = require('../persistence/PersistenceManager');

const SERVER_ID = process.env.SERVER_ID || 'FRA-01';
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost';
const GATEWAY_URL = process.env.GATEWAY_URL || Config.GATEWAY.URL;

const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');
const STATIC_ROOT     = path.dirname(INDEX_HTML_PATH);

/**
 * The base URL this instance advertises to the gateway (as its admin API
 * base) and, via the gateway, to clients (as the base of their game
 * connection). This is NOT simply `${PUBLIC_HOST}:${PORT}` -- that only
 * holds for bare local sockets. The moment this runs behind a
 * TLS-terminating host (Render, and most PaaS providers), the public
 * address has no port in it at all and uses https/wss, while PORT is
 * only the *internal* port the platform forwards to.
 *
 * Resolution order:
 *   1. PUBLIC_BASE_URL  - explicit override, e.g. 'https://fra-01.example.com'
 *   2. RENDER_EXTERNAL_URL - set automatically by Render for every web
 *      service (e.g. 'https://blade-world-fra-01.onrender.com'); zero
 *      config needed on Render specifically.
 *   3. `http://${PUBLIC_HOST}:${PORT}` - local development fallback,
 *      where the raw host:port really is what's reachable.
 */
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://${PUBLIC_HOST}:${PORT}`
).replace(/\/+$/, '');
const ADMIN_URL = PUBLIC_BASE_URL;
const WS_URL = PUBLIC_BASE_URL.replace(/^http/, 'ws'); // http->ws, https->wss

// -------------------------------------------------------------------------
// Core wiring: one WorldManager (every World this process hosts), one
// SimulationLoop (ticks all of them), one PersistenceManager placeholder
// (see persistence/PersistenceManager.js), one WebSocket layer.
// -------------------------------------------------------------------------
const persistence = new PersistenceManager();
const worldManager = new WorldManager(SERVER_ID, undefined, persistence);
const simulationLoop = new SimulationLoop(worldManager);

// Seeds one starter world so `node world/WorldServer.js` is immediately
// playable on its own, exactly like the original single-server
// foundation -- a real deployment would normally let the gateway trigger
// creation on demand instead, but an empty instance with nothing to join
// is a bad default for local development.
worldManager.createWorld({ type: Config.DEFAULT_WORLD_TYPE });

/** connection id -> the worldId that connection currently belongs to. Lets onMessage/onDisconnect route to the right (and only the right) World. */
const connectionWorld = new Map();

// -------------------------------------------------------------------------
// HTTP: static index.html (dev convenience) + the admin JSON API that lets
// the gateway create/destroy worlds on this instance and inspect status.
// Gateway should NOT simulate gameplay -- everything it asks for here is
// pure bookkeeping, the same operations WorldManager already exposes.
// -------------------------------------------------------------------------
const httpServer = http.createServer(async (req, res) => {
  if (serveStatic(req, res, STATIC_ROOT)) return;

  if (req.method === 'GET' && req.url === '/admin/status') {
    sendJson(res, 200, worldManager.serializeStatus());
    return;
  }

  if (req.method === 'POST' && req.url === '/admin/worlds') {
    try {
      const body = await readJsonBody(req);
      const world = worldManager.createWorld({ type: body.type, capacity: body.capacity });
      if (!world) {
        sendJson(res, 409, { error: 'This instance is at MAX_WORLDS capacity.' });
        return;
      }
      sendJson(res, 201, {
        worldId: world.id,
        type: world.type,
        capacity: world.settings.capacity,
        serverId: SERVER_ID,
        wsUrl: WS_URL,
      });
    } catch (err) {
      sendJson(res, 400, { error: 'Malformed request body.' });
    }
    return;
  }

  const destroyMatch = req.method === 'DELETE' && req.url.match(/^\/admin\/worlds\/([^/]+)$/);
  if (destroyMatch) {
    const ok = worldManager.destroyWorld(decodeURIComponent(destroyMatch[1]));
    sendJson(res, ok ? 200 : 404, { destroyed: ok });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// -------------------------------------------------------------------------
// WebSocket: actual game clients land here after the gateway redirects
// them (see gateway/gateway.js), or connect directly for local dev.
// -------------------------------------------------------------------------
const wsServer = new GameWebSocketServer(httpServer);

/** Resolves which World a newly-connecting socket should join. */
function resolveWorldForConnection(query) {
  const requestedType = Config.WORLD_TYPES[query.type] ? query.type : Config.DEFAULT_WORLD_TYPE;

  if (query.worldId) {
    const world = worldManager.getWorld(query.worldId);
    if (world && !world.isFull) return world;
    // The world we were sent to is gone or filled up since assignment --
    // fall back to auto-assignment of the same type rather than just
    // failing the connection outright. This is part of "prevent orphan
    // worlds" from the client's perspective: a stale assignment self-heals.
  }
  return worldManager.autoAssignPlayer(requestedType);
}

wsServer.onConnect = (id, query) => {
  const world = resolveWorldForConnection(query);
  if (!world) {
    wsServer.send(id, { type: MessageTypes.S2C_ASSIGNMENT_ERROR, reason: 'This server instance is full.' });
    wsServer.close(id, 1013, 'server full');
    return;
  }

  let player = null;
  let rejoined = false;
  if (query.worldId === world.id && query.rejoinToken) {
    player = world.rejoinPlayer(id, query.rejoinToken);
    rejoined = !!player;
  }
  if (!player) {
    if (query.rejoinToken) {
      wsServer.send(id, { type: MessageTypes.S2C_REJOIN_FAILED });
    }
    player = world.addPlayer(id);
  }

  if (!player) {
    wsServer.send(id, { type: MessageTypes.S2C_ASSIGNMENT_ERROR, reason: 'World is full.' });
    wsServer.close(id, 1013, 'world full');
    return;
  }

  connectionWorld.set(id, world.id);

  // Connection-identity packet, sent before 'welcome' so the client's
  // debug UI can show server/world identity immediately. Per the
  // architecture brief's networking section: { serverId, worldId, tickRate }.
  wsServer.send(id, {
    type: MessageTypes.S2C_CONNECTION_INFO,
    serverId: SERVER_ID,
    worldId: world.id,
    worldType: world.type,
    tickRate: world.settings.tickRate,
    rejoinToken: player.rejoinToken,
  });

  wsServer.send(id, {
    type: MessageTypes.S2C_WELCOME,
    id,
    tick: world.currentTick,
    serverId: SERVER_ID,
    worldId: world.id,
    worldType: world.type,
    capacity: world.settings.capacity,
    config: {
      movement: Config.MOVEMENT,
      serverTickRate: world.settings.tickRate,
      snapshotRate: Config.SNAPSHOT_RATE,
      worldBounds: world.settings.bounds,
    },
    snapshot: world.buildSnapshot(),
  });

  wsServer.sendToMany(Array.from(world.players.keys()), { type: MessageTypes.S2C_PLAYER_JOINED, id });
  console.log(
    `[${SERVER_ID}] ${rejoined ? 'rejoin' : 'connect'} ${id} -> ${world.id} (${world.playerCount}/${world.settings.capacity})`
  );
};

wsServer.onDisconnect = (id, reason) => {
  const worldId = connectionWorld.get(id);
  connectionWorld.delete(id);
  if (!worldId) return;

  const world = worldManager.getWorld(worldId);
  if (!world) return;

  world.removePlayer(id);
  wsServer.sendToMany(Array.from(world.players.keys()), { type: MessageTypes.S2C_PLAYER_LEFT, id });
  console.log(`[${SERVER_ID}] disconnect (${reason}) ${id} <- ${world.id} (${world.playerCount}/${world.settings.capacity})`);
};

wsServer.onMessage = (id, message) => {
  const worldId = connectionWorld.get(id);
  const world = worldId ? worldManager.getWorld(worldId) : null;
  if (!world) return;

  switch (message.type) {
    case MessageTypes.C2S_INPUT:
      world.queueInput(id, message);
      break;

    case MessageTypes.C2S_PING:
      // Echo the client's own send-timestamp back unchanged -- no clock
      // synchronization needed, the client computes its own RTT.
      wsServer.send(id, { type: MessageTypes.S2C_PONG, clientSendTime: message.clientSendTime });
      break;

    default:
      // Unknown message type -- ignore, keeps the protocol easy to
      // extend later (e.g. future combat message types).
      break;
  }
};

// -------------------------------------------------------------------------
// Loop 1: authoritative simulation, fixed-rate tick across every world
// this instance hosts (see world/SimulationLoop.js).
// -------------------------------------------------------------------------
simulationLoop.start();

// -------------------------------------------------------------------------
// Loop 2: snapshot broadcast, fixed-rate (SNAPSHOT_RATE), per world. Each
// world's snapshot only ever reaches that world's own players -- this is
// the wire-level expression of "no shared gameplay state".
// -------------------------------------------------------------------------
const snapshotIntervalMs = 1000 / Config.SNAPSHOT_RATE;
setInterval(() => {
  for (const world of worldManager.getAllWorlds()) {
    if (world.playerCount === 0) continue;
    wsServer.sendToMany(Array.from(world.players.keys()), world.buildSnapshot());
  }
}, snapshotIntervalMs);

// -------------------------------------------------------------------------
// Gateway registration + heartbeat. Best-effort: failures are logged, not
// fatal, so this instance keeps serving even if the gateway is briefly
// (or permanently, for local dev) unreachable.
// -------------------------------------------------------------------------
function registerWithGateway() {
  postJson(`${GATEWAY_URL}/gateway/register`, {
    serverId: SERVER_ID,
    adminUrl: ADMIN_URL,
    wsUrl: WS_URL,
    maxWorlds: worldManager.limits.MAX_WORLDS,
    maxPlayers: worldManager.limits.MAX_PLAYERS,
    maxEntities: worldManager.limits.MAX_ENTITIES,
    supportedTypes: Object.keys(Config.WORLD_TYPES),
  })
    .then(() => console.log(`[${SERVER_ID}] registered with gateway at ${GATEWAY_URL}`))
    .catch((err) => console.warn(`[${SERVER_ID}] gateway registration failed (will retry): ${err.message}`));
}

function sendHeartbeat() {
  postJson(`${GATEWAY_URL}/gateway/heartbeat`, worldManager.serializeStatus()).catch((err) => {
    // Heartbeat failures are expected/benign when running standalone
    // without a gateway -- don't spam the console every interval.
  });
}

registerWithGateway();
const registrationRetryTimer = setInterval(registerWithGateway, Config.GATEWAY.HEARTBEAT_INTERVAL_MS * 2);
const heartbeatTimer = setInterval(sendHeartbeat, Config.GATEWAY.HEARTBEAT_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`[${SERVER_ID}] world server listening on ${ADMIN_URL}`);
  console.log(`[${SERVER_ID}] simulation: ${Config.SERVER_TICK_RATE}Hz | snapshots: ${Config.SNAPSHOT_RATE}Hz`);
});

function shutdown() {
  console.log(`[${SERVER_ID}] shutting down...`);
  clearInterval(registrationRetryTimer);
  clearInterval(heartbeatTimer);
  simulationLoop.stop();
  worldManager.shutdown();
  httpServer.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
