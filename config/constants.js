/**
 * config/constants.js
 * -----------------------------------------------------------------------
 * Single source of truth for server tuning values.
 *
 * Architecture note:
 *   The client does NOT hardcode its own copy of MOVEMENT/tick-rate values.
 *   On connect, the world server sends a subset of this file inside the
 *   'welcome' message (see world/WorldServer.js). That guarantees the
 *   client's prediction math (MovementSystem on the client) can never
 *   drift out of sync with the server's authoritative movement math just
 *   because someone tuned a constant in one place and forgot the other.
 *
 *   Everything in here is plain data (no functions) so it can be safely
 *   JSON-serialized and shipped to clients as-is.
 *
 * Multi-instance additions (gateway / world-server split):
 *   The original MOVEMENT / SERVER_TICK_RATE / SNAPSHOT_RATE / WORLD /
 *   SPAWN / LIMITS blocks below are UNCHANGED from the single-server
 *   foundation -- every world still simulates movement with exactly this
 *   tuning. Everything under GATEWAY, WORLD_TYPES, SERVER_LIMITS, and
 *   RELIABILITY is new and purely additive: it configures *how many*
 *   worlds/servers exist and *how they talk to each other*, not how an
 *   individual entity moves.
 * -----------------------------------------------------------------------
 */

module.exports = {
  // How often the authoritative simulation advances. This is the "truth"
  // rate -- everything server-side (input consumption, movement, future
  // combat/AI ticks) is driven off this number.
  SERVER_TICK_RATE: 30, // Hz

  // How often we package the simulation state and broadcast it to clients.
  // Deliberately decoupled from SERVER_TICK_RATE: simulating and
  // broadcasting are different concerns with different cost profiles, and
  // splitting them means we can later raise simulation fidelity (e.g. for
  // combat hit-detection) without proportionally increasing bandwidth.
  SNAPSHOT_RATE: 20, // Hz

  // Movement tuning. Shared verbatim with the client for prediction.
  MOVEMENT: {
    MAX_SPEED: 6.0,       // m/s, top horizontal movement speed
    ACCELERATION: 40.0,   // m/s^2 applied while there is movement input
    FRICTION: 18.0,       // m/s^2 deceleration applied while there is no input
    TURN_RATE: 12.0,      // rad/s, how fast the entity's facing rotates to match its movement direction
  },

  // World bounds. Today this is just a simple square clamp; it exists as a
  // placeholder for a future spatial/chunking system (see EntityManager
  // comments) rather than real collision.
  WORLD: {
    BOUNDS: 50, // half-extent, in meters, of the playable square area
  },

  SPAWN: {
    RADIUS: 8, // players spawn at a random point within this radius of the origin
  },

  // Safety limits, not gameplay tuning. These exist purely to stop a
  // misbehaving or malicious client from growing unbounded server memory.
  LIMITS: {
    MAX_QUEUED_INPUTS_PER_PLAYER: 64,
  },

  // -----------------------------------------------------------------------
  // WORLD_TYPES
  // -----------------------------------------------------------------------
  // Per-type defaults for dynamically created worlds. `capacity` is the
  // default maxPlayers for a world of that type unless overridden by the
  // caller of WorldManager.createWorld(). Purely metadata today -- no
  // type-specific gameplay logic exists yet (combat/AI/missions are
  // explicitly out of scope), but WorldManager and the gateway both key
  // off this list to validate `type` and to know what's creatable.
  WORLD_TYPES: {
    destination: { capacity: 24, maxEntities: 256, label: 'Fractura Destination' },
    hunt: { capacity: 8, maxEntities: 128, label: 'Hollow Hunt' },
    cleansing: { capacity: 12, maxEntities: 128, label: 'Cleansing' },
    extraction: { capacity: 10, maxEntities: 128, label: 'Extraction' },
    pvp: { capacity: 16, maxEntities: 64, label: 'PvP Arena' },
  },
  DEFAULT_WORLD_TYPE: 'destination',

  // -----------------------------------------------------------------------
  // SERVER_LIMITS
  // -----------------------------------------------------------------------
  // Capacity ceilings for a single world-server PROCESS (one instance can
  // host many worlds, per the architecture brief -- these are the guard
  // rails that stop one instance from being asked to host more than it
  // can handle). Overridable per-process via environment variables so
  // different instances (FRA-01 vs PVP-01) can run different ceilings
  // without a code change.
  SERVER_LIMITS: {
    MAX_WORLDS: Number(process.env.MAX_WORLDS) || 20,
    MAX_PLAYERS: Number(process.env.MAX_PLAYERS) || 200,
    MAX_ENTITIES: Number(process.env.MAX_ENTITIES) || 4000,
  },

  // -----------------------------------------------------------------------
  // GATEWAY
  // -----------------------------------------------------------------------
  GATEWAY: {
    // PORT is the platform-provided port (Render, and most PaaS hosts,
    // inject this and expect the service to bind to it -- ignoring it
    // and binding to a hardcoded port instead is the single most common
    // reason a Node web service fails to deploy on Render). GATEWAY_PORT
    // remains as a local-dev convenience for running the gateway on a
    // specific port without colliding with a world server on the same
    // machine. 9000 is the final fallback for plain local development.
    PORT: Number(process.env.PORT || process.env.GATEWAY_PORT) || 9000,
    URL: process.env.GATEWAY_URL || `https://blade-of-the-void-gateway-backend.onrender.com/`,
    // How often a world server pushes its population/health stats to the
    // gateway, and how long the gateway will tolerate silence before it
    // considers that server offline and stops assigning players to it.
    HEARTBEAT_INTERVAL_MS: 5000,
    SERVER_TIMEOUT_MS: 15000,
  },

  // -----------------------------------------------------------------------
  // RELIABILITY
  // -----------------------------------------------------------------------
  RELIABILITY: {
    // A connection that has sent nothing (not even a ping) in this long is
    // swept by WebSocketServer's stale-connection check, even if the
    // underlying TCP socket never fired a 'close' event.
    CONNECTION_TIMEOUT_MS: 20000,
    CONNECTION_SWEEP_INTERVAL_MS: 5000,
    // After a player disconnects, their session (entity state + a
    // rejoin token) is kept for this long so a client that reconnects
    // quickly (e.g. brief wifi drop) gets its same entity back instead of
    // respawning as a new one.
    REJOIN_GRACE_MS: 30000,
    // A world with zero players is destroyed after being empty for this
    // long, freeing it from the registry rather than lingering forever as
    // an orphaned, never-cleaned-up world.
    EMPTY_WORLD_GC_MS: 60000,
    WORLD_GC_SWEEP_INTERVAL_MS: 10000,
  },
};
