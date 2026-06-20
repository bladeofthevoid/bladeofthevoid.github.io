/**
 * server.js
 * =========================================================================
 * Entry point. This file does ONE job: wire the independent modules
 * together and run the two fixed-rate loops. It contains no game logic
 * of its own -- movement lives in simulation/, entity storage in
 * entities/, the wire protocol in network/, etc. If you're looking for
 * "how does movement work", you want simulation/MovementSystem.js, not
 * this file.
 *
 * Run with:  npm install && node server.js
 * Then open: http://localhost:8080
 *
 * Architecture at a glance
 * -------------------------------------------------------------------------
 *   network/WebSocketServer  <-- raw connections, JSON in/out, no game knowledge
 *           |
 *           v  (onConnect / onMessage / onDisconnect callbacks)
 *   server.js (this file)    <-- the only place that knows about all the pieces
 *           |
 *           +--> entities/EntityManager   <-- authoritative entity storage
 *           +--> simulation/SimulationWorld <-- 30Hz: consumes input, moves entities
 *           +--> snapshots/SnapshotManager  <-- 20Hz: packages state to broadcast
 *
 * Two independent loops, on purpose (see "Tick architecture" in the
 * project brief): simulating state and broadcasting state are different
 * concerns with different costs, and decoupling their rates means either
 * can be tuned later without affecting the other.
 * =========================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const Config = require('./config/constants');
const MessageTypes = require('./network/MessageTypes');
const GameWebSocketServer = require('./network/WebSocketServer');

const EntityManager = require('./entities/EntityManager');
const Player = require('./entities/Player');

const SimulationWorld = require('./simulation/SimulationWorld');
const SnapshotManager = require('./snapshots/SnapshotManager');

// -------------------------------------------------------------------------
// Minimal static file server, just enough to serve index.html so the
// whole project runs from a single `node server.js` with no separate
// static-file tooling. Anything beyond index.html (a real asset pipeline,
// caching, etc.) is explicitly out of scope for this foundation.
// -------------------------------------------------------------------------
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(INDEX_HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to load index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// -------------------------------------------------------------------------
// Wire the modules together.
// -------------------------------------------------------------------------
const entityManager = new EntityManager();
const simulationWorld = new SimulationWorld(entityManager);
const snapshotManager = new SnapshotManager(entityManager, simulationWorld);
const wsServer = new GameWebSocketServer(httpServer);

/** Spawns players spread around the origin instead of stacked on top of each other. */
function randomSpawnPoint() {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * Config.SPAWN.RADIUS;
  return {
    x: Math.cos(angle) * radius,
    y: 0,
    z: Math.sin(angle) * radius,
  };
}

wsServer.onConnect = (id) => {
  const player = new Player(id, randomSpawnPoint());
  entityManager.addEntity(player);

  // The 'welcome' message is the only place tuning constants travel to
  // the client. The client uses these verbatim for its own prediction
  // math instead of hardcoding a second copy that could drift out of
  // sync with config/constants.js. See index.html's NetworkManager.onWelcome.
  wsServer.send(id, {
    type: MessageTypes.S2C_WELCOME,
    id,
    tick: simulationWorld.currentTick,
    config: {
      movement: Config.MOVEMENT,
      serverTickRate: Config.SERVER_TICK_RATE,
      snapshotRate: Config.SNAPSHOT_RATE,
      worldBounds: Config.WORLD.BOUNDS,
    },
    snapshot: snapshotManager.buildSnapshot(),
  });

  wsServer.broadcast({ type: MessageTypes.S2C_PLAYER_JOINED, id });
  console.log(`[connect] ${id} (${entityManager.getEntitiesByType('player').length} player(s) online)`);
};

wsServer.onDisconnect = (id) => {
  entityManager.removeEntity(id);
  wsServer.broadcast({ type: MessageTypes.S2C_PLAYER_LEFT, id });
  console.log(`[disconnect] ${id} (${entityManager.getEntitiesByType('player').length} player(s) online)`);
};

wsServer.onMessage = (id, message) => {
  switch (message.type) {
    case MessageTypes.C2S_INPUT:
      simulationWorld.queueInput(id, message);
      break;

    case MessageTypes.C2S_PING:
      // Echo the client's own send-timestamp back unchanged. The client
      // computes RTT itself as (now - echoedTimestamp); the server does
      // not need to know or care about clock synchronization.
      wsServer.send(id, { type: MessageTypes.S2C_PONG, clientSendTime: message.clientSendTime });
      break;

    default:
      // Unknown message type -- ignore. Keeping this permissive (rather
      // than disconnecting) makes the protocol easy to extend later
      // (e.g. adding combat-related message types) without every old
      // client needing to recognize every new type.
      break;
  }
};

// -------------------------------------------------------------------------
// Loop 1: authoritative simulation, fixed 30Hz tick (SERVER_TICK_RATE).
// This is the only place player position is ever computed.
// -------------------------------------------------------------------------
const simulationIntervalMs = 1000 / Config.SERVER_TICK_RATE;
setInterval(() => {
  simulationWorld.tick();
}, simulationIntervalMs);

// -------------------------------------------------------------------------
// Loop 2: snapshot broadcast, fixed 20Hz (SNAPSHOT_RATE). Deliberately a
// separate setInterval from the simulation loop -- see module header.
// -------------------------------------------------------------------------
const snapshotIntervalMs = 1000 / Config.SNAPSHOT_RATE;
setInterval(() => {
  wsServer.broadcast(snapshotManager.buildSnapshot());
}, snapshotIntervalMs);

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Combat game foundation server listening on http://localhost:${PORT}`);
  console.log(`Simulation: ${Config.SERVER_TICK_RATE}Hz | Snapshots: ${Config.SNAPSHOT_RATE}Hz`);
});
