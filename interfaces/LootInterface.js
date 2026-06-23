/**
 * interfaces/LootInterface.js
 * -----------------------------------------------------------------------
 * NOT IMPLEMENTED. Documents the shape a future loot/drop system would
 * expose. Per project scope, loot and inventory are explicitly excluded
 * -- do not implement these methods.
 *
 * Expected future shape:
 *   class LootSystem {
 *     rollDrop(source, table) {}
 *     grantToPlayer(player, item) {}
 *     onEntityRemove(world, entity) {}   // e.g. roll drops when an Enemy dies
 *   }
 * -----------------------------------------------------------------------
 */

class LootInterface {
  rollDrop(source, table) {
    throw new Error('LootInterface.rollDrop is not implemented (out of scope).');
  }
}

module.exports = LootInterface;
