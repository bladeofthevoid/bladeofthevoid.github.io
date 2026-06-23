/**
 * interfaces/EnemySystem.js
 * -----------------------------------------------------------------------
 * NOT IMPLEMENTED. entities/Enemy.js already defines the *data* shape of
 * an enemy entity (position, type, serialize()). This file documents the
 * shape of the *system* that would spawn, drive AI for, and despawn
 * Enemy entities inside a World. Per project scope, AI is explicitly
 * excluded -- do not implement these methods.
 *
 * Expected future shape:
 *   class EnemySystem {
 *     spawnEnemy(world, archetype, position) {}   // creates an Enemy, world.spawnEntity(...)
 *     onWorldUpdate(world) {}                       // drive AI/behavior per tick
 *     despawnEnemy(world, enemyId) {}
 *   }
 * -----------------------------------------------------------------------
 */

class EnemySystem {
  spawnEnemy(world, archetype, position) {
    throw new Error('EnemySystem.spawnEnemy is not implemented (out of scope).');
  }
}

module.exports = EnemySystem;
