/**
 * interfaces/CombatInterface.js
 * -----------------------------------------------------------------------
 * NOT IMPLEMENTED. This documents the shape a future combat system would
 * expose, so World.js, EntityManager, and the network layer can already
 * be combat-ready (per-entity worldId stamping, a `combat` slot on
 * Player, the Enemy/Projectile entity stubs) without any combat logic
 * actually existing yet. Per project scope, combat is explicitly excluded
 * -- do not implement these methods.
 *
 * Expected future shape:
 *   class CombatSystem {
 *     resolveHit(attacker, target, ability) {}   // damage/stagger resolution
 *     applyDamage(entity, amount, source) {}      // mutate entity.combat.health
 *     isDead(entity) {}
 *     onEntityRemove(world, entity) {}             // cleanup aggro/threat tables
 *   }
 * -----------------------------------------------------------------------
 */

class CombatInterface {
  resolveHit(attacker, target, ability) {
    throw new Error('CombatInterface.resolveHit is not implemented (out of scope).');
  }
}

module.exports = CombatInterface;
