/**
 * simulation/MovementSystem.js
 * -----------------------------------------------------------------------
 * Pure, deterministic movement math. No I/O, no entity-manager lookups,
 * no networking -- just: given a state, an input, a timestep and the
 * tuning constants, compute the next state.
 *
 * Why this matters architecturally:
 *   This exact logic is duplicated in index.html (search for
 *   "MovementSystem" there) so the client can run it locally for
 *   prediction. Determinism is the whole point of client prediction: if
 *   the client runs the SAME function with the SAME inputs and timestep
 *   as the server will, its predicted position should match what the
 *   server eventually confirms, and any mismatch is genuine drift to be
 *   corrected by reconciliation -- not a bug caused by the two sides
 *   computing movement differently.
 *
 *   Keep this file free of anything non-deterministic (Math.random,
 *   wall-clock reads, etc.) or that guarantee breaks.
 * -----------------------------------------------------------------------
 */

class MovementSystem {
  /**
   * Advances one entity's movement state by one fixed timestep, in place.
   *
   * @param {{position:{x,y,z}, velocity:{x,y,z}, rotationY:number, movementState:string}} state
   *   Mutated in place and also returned, so callers can chain.
   * @param {{dirX:number, dirZ:number}} input
   *   Desired movement direction in world space, expected (but not
   *   required) to already be normalized. {0,0} means "no input".
   * @param {number} dt - fixed timestep in seconds (e.g. 1/30)
   * @param {{MAX_SPEED:number, ACCELERATION:number, FRICTION:number, TURN_RATE:number}} cfg
   */
  static step(state, input, dt, cfg) {
    const dirX = input.dirX || 0;
    const dirZ = input.dirZ || 0;
    const hasInput = dirX !== 0 || dirZ !== 0;

    if (hasInput) {
      // Defensively re-normalize: never trust a client (or a future AI
      // controller) to have sent a perfectly unit-length vector. This is
      // also part of why movement can be server-authoritative even though
      // the client picks the direction -- a malformed/cheated vector
      // longer than 1 can't translate into faster-than-MAX_SPEED movement.
      const len = Math.hypot(dirX, dirZ) || 1;
      const nx = dirX / len;
      const nz = dirZ / len;

      const targetVX = nx * cfg.MAX_SPEED;
      const targetVZ = nz * cfg.MAX_SPEED;

      state.velocity.x = MovementSystem._approach(state.velocity.x, targetVX, cfg.ACCELERATION * dt);
      state.velocity.z = MovementSystem._approach(state.velocity.z, targetVZ, cfg.ACCELERATION * dt);

      // Face the direction of movement. atan2(x, z) (note the argument
      // order) is paired deliberately with how rotationY is rendered on
      // the client: rotationY=0 means "facing +Z", and rotating an object
      // by rotationY about the Y axis sweeps its local +Z axis to world
      // direction (sin(rotationY), 0, cos(rotationY)) -- exactly the
      // inverse of this atan2 call. See index.html EntityView for the
      // matching rendering-side convention.
      const targetYaw = Math.atan2(nx, nz);
      state.rotationY = MovementSystem._approachAngle(state.rotationY, targetYaw, cfg.TURN_RATE * dt);

      state.movementState = 'moving';
    } else {
      state.velocity.x = MovementSystem._approach(state.velocity.x, 0, cfg.FRICTION * dt);
      state.velocity.z = MovementSystem._approach(state.velocity.z, 0, cfg.FRICTION * dt);
      state.movementState = 'idle';
    }

    state.position.x += state.velocity.x * dt;
    state.position.z += state.velocity.z * dt;
    // Flat ground baseline. There is no physics engine in this
    // foundation (by design) -- a future terrain-height or gravity system
    // would set state.position.y here instead of pinning it to 0.
    state.position.y = 0;

    return state;
  }

  /** Moves `current` toward `target` by at most `maxDelta`. */
  static _approach(current, target, maxDelta) {
    if (current < target) return Math.min(current + maxDelta, target);
    if (current > target) return Math.max(current - maxDelta, target);
    return current;
  }

  /** Like _approach, but for angles, taking the shortest path around the circle. */
  static _approachAngle(current, target, maxDelta) {
    let diff = target - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const delta = Math.max(-maxDelta, Math.min(maxDelta, diff));
    return current + delta;
  }
}

module.exports = MovementSystem;
