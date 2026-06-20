/**
 * config/constants.js
 * -----------------------------------------------------------------------
 * Single source of truth for server tuning values.
 *
 * Architecture note:
 *   The client does NOT hardcode its own copy of MOVEMENT/tick-rate values.
 *   On connect, the server sends a subset of this file inside the
 *   'welcome' message (see server.js). That guarantees the client's
 *   prediction math (MovementSystem on the client) can never drift out of
 *   sync with the server's authoritative movement math just because
 *   someone tuned a constant in one place and forgot the other.
 *
 *   Everything in here is plain data (no functions) so it can be safely
 *   JSON-serialized and shipped to clients as-is.
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
};
