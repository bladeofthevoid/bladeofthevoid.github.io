/**
 * interfaces/ProjectileSystem.js
 * -----------------------------------------------------------------------
 * NOT IMPLEMENTED. entities/Projectile.js already defines the *data*
 * shape of a projectile entity. This file documents the shape of the
 * *system* that would spawn, fly, and resolve collisions for projectiles
 * inside a World. Per project scope, this is explicitly excluded -- do
 * not implement these methods.
 *
 * Expected future shape:
 *   class ProjectileSystem {
 *     fire(world, owner, direction, speed) {}   // creates a Projectile, world.spawnEntity(...)
 *     onWorldUpdate(world) {}                     // linear motion + lifetime expiry + hit-detection
 *   }
 * -----------------------------------------------------------------------
 */

class ProjectileSystem {
  fire(world, owner, direction, speed) {
    throw new Error('ProjectileSystem.fire is not implemented (out of scope).');
  }
}

module.exports = ProjectileSystem;
