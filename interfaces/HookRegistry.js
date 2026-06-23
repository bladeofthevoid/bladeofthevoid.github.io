/**
 * interfaces/HookRegistry.js
 * -----------------------------------------------------------------------
 * Extensibility seam ONLY -- no behavior lives here.
 *
 * World.js calls these hooks at well-defined points in its lifecycle
 * (creation, every tick, player join/leave, entity spawn/remove,
 * destruction). Every hook is a documented no-op. The point of this file
 * is that World.js never has to change again when combat, AI, abilities,
 * missions, or loot are eventually implemented -- those systems register
 * their own HookRegistry (or a subclass overriding the methods they care
 * about) instead of World.js growing `if (this.type === 'pvp') { ... }`
 * branches.
 *
 * How a future system would use this (illustrative, not implemented):
 *   class CombatHooks extends HookRegistry {
 *     onWorldUpdate(world) { combatSystem.resolveHits(world); }
 *     onPlayerLeave(world, player) { combatSystem.clearAggro(player); }
 *   }
 *   new World({ ..., hooks: new CombatHooks() })
 *
 * Per project scope, no subclass exists yet -- World.js is always handed
 * a plain `new HookRegistry()` today, so every call below is a no-op.
 * -----------------------------------------------------------------------
 */

class HookRegistry {
  /** Called once, right after WorldManager finishes constructing the world. */
  onWorldCreated(world) {}

  /** Called once per simulation tick, after movement has been applied. */
  onWorldUpdate(world) {}

  /** Called after a new player's entity has been added to the world. */
  onPlayerJoin(world, player) {}

  /** Called after a player's entity has been removed from the world. */
  onPlayerLeave(world, player) {}

  /** Called after any entity (player or future Enemy/Projectile) is added. */
  onEntitySpawn(world, entity) {}

  /** Called after any entity is removed. */
  onEntityRemove(world, entity) {}

  /** Called once, right before WorldManager tears the world down. */
  onWorldDestroy(world) {}
}

module.exports = HookRegistry;
