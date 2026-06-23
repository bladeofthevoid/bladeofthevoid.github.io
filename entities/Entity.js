/**
 * entities/Entity.js
 * -----------------------------------------------------------------------
 * Base class for every simulated object on the server.
 *
 * Deliberately NOT an ECS (per project requirements: no ECS framework).
 * Instead this is plain inheritance: a small, honest base class with the
 * fields every entity needs, and subclasses add behavior. For a project
 * this size that's easier to read and extend than a component system,
 * and nothing here prevents migrating to ECS later if entity variety
 * explodes (Player/Enemy/Projectile are intentionally kept as separate,
 * self-contained classes rather than tangled together, which makes that
 * future migration easier rather than harder).
 * -----------------------------------------------------------------------
 */

class Entity {
  /**
   * @param {string} id - unique identifier
   * @param {string} type - short string used by the client to decide how
   *   to render this entity ('player', 'enemy', 'projectile', ...)
   */
  constructor(id, type) {
    this.id = id;
    this.type = type;

    // Which isolated World this entity belongs to. Set by World.js when
    // the entity is added (see World.addPlayer/spawnEntity). Entities
    // never move between worlds, so this is set once and never mutated --
    // it exists purely so a serialized entity packet is self-describing
    // (a client that somehow received state for the wrong world, e.g.
    // during a transfer race, can detect and discard it).
    this.worldId = null;

    this.position = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.rotationY = 0; // facing, radians, rotation about the world Y axis

    // Human/AI-readable movement state, e.g. 'idle' | 'moving'. Kept as a
    // plain string rather than an enum class to stay JSON-friendly and to
    // leave room for future states (e.g. 'attacking', 'staggered') without
    // touching the serialization code.
    this.movementState = 'idle';

    // The simulation tick at which this entity's state was last computed.
    // Included in every snapshot so clients can reason about *when* a
    // given state was true, which matters for interpolation/reconciliation.
    this.tick = 0;
  }

  /**
   * Produces the plain-data representation sent to clients inside
   * snapshots. Subclasses that add combat-relevant fields later (health,
   * stagger state, etc.) should override this and call super.serialize()
   * to extend rather than replace it.
   */
  serialize() {
    return {
      id: this.id,
      type: this.type,
      worldId: this.worldId,
      position: this.position,
      velocity: this.velocity,
      rotationY: this.rotationY,
      movementState: this.movementState,
      tick: this.tick,
    };
  }
}

module.exports = Entity;
