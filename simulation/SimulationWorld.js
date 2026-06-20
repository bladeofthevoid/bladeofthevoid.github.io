/**
 * simulation/SimulationWorld.js
 * -----------------------------------------------------------------------
 * The authoritative simulation. Owns the server's tick counter and, once
 * per tick, consumes exactly one queued input per player and advances
 * their movement via MovementSystem.
 *
 * Server authority, concretely:
 *   - Clients only ever send an input *direction*; this class is the only
 *     thing that turns that into an actual position. A client cannot
 *     directly set its own position, velocity, or speed.
 *   - tick() always advances using `this.fixedDt` (derived from
 *     config), never a client-reported delta-time. A client lying about
 *     elapsed time cannot make itself move faster -- the server's clock
 *     is the only clock that counts.
 *   - Input direction vectors are clamped/re-normalized before being
 *     queued (see queueInput), and MovementSystem re-normalizes again
 *     defensively, so a malformed or hostile input can't exceed MAX_SPEED.
 * -----------------------------------------------------------------------
 */

const MovementSystem = require('./MovementSystem');
const Config = require('../config/constants');

class SimulationWorld {
  constructor(entityManager) {
    this.entityManager = entityManager;
    this.currentTick = 0;
    this.fixedDt = 1 / Config.SERVER_TICK_RATE;
  }

  /**
   * Called by the network layer whenever an 'input' message arrives.
   * Does NOT apply the input immediately -- it's queued and consumed by
   * the next tick() call, which is what keeps movement locked to the
   * simulation's tick rate instead of to packet arrival timing.
   */
  queueInput(playerId, input) {
    const player = this.entityManager.getEntity(playerId);
    if (!player || player.type !== 'player') return;

    // Defensive clamping -- never trust raw network input.
    const dirX = clamp(Number(input.dirX) || 0, -1, 1);
    const dirZ = clamp(Number(input.dirZ) || 0, -1, 1);
    const seq = Number.isFinite(input.seq) ? input.seq : player.lastProcessedInputSeq;

    player.inputQueue.push({ dirX, dirZ, seq });

    // Bound memory if a client floods inputs faster than we can consume
    // them (e.g. a stalled tab catching back up) -- drop the oldest.
    if (player.inputQueue.length > Config.LIMITS.MAX_QUEUED_INPUTS_PER_PLAYER) {
      player.inputQueue.shift();
    }
  }

  /** Advances the world by exactly one fixed simulation tick. */
  tick() {
    this.currentTick++;

    for (const player of this.entityManager.getEntitiesByType('player')) {
      const input = player.inputQueue.shift();

      if (input) {
        player.lastProcessedInputSeq = input.seq;
      }
      // Input starvation (client lagging / packet loss): fall back to "no
      // input" rather than repeating the last direction, so a momentary
      // stall reads as the player releasing keys rather than continuing
      // to walk into a wall.
      const effectiveInput = input || { dirX: 0, dirZ: 0 };

      MovementSystem.step(player, effectiveInput, this.fixedDt, Config.MOVEMENT);

      // Simple world-bounds clamp. Not a collision system -- just keeps
      // players from wandering into the void until a real boundary/level
      // system exists.
      player.position.x = clamp(player.position.x, -Config.WORLD.BOUNDS, Config.WORLD.BOUNDS);
      player.position.z = clamp(player.position.z, -Config.WORLD.BOUNDS, Config.WORLD.BOUNDS);

      player.tick = this.currentTick;
    }

    // Hook for future self-updating entities (enemy AI, projectile
    // flight). No-op today since only Player entities exist.
    this.entityManager.update(this.fixedDt);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = SimulationWorld;
