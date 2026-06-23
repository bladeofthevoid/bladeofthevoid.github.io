/**
 * tests/world-manager.unit.test.js
 * -----------------------------------------------------------------------
 * Pure server-side unit test, no network involved: exercises
 * world/WorldManager.js directly to verify
 *   - createWorld() / destroyWorld()
 *   - autoAssignPlayer() creates a new world of the same type once the
 *     existing one is full ("Destination full -> create Destination-02")
 *   - SERVER_LIMITS.MAX_WORLDS is actually enforced
 * -----------------------------------------------------------------------
 */

const WorldManager = require('../world/WorldManager');

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures++;
    console.error('FAIL:', message);
  }
}

const wm = new WorldManager('TEST-01');

const w1 = wm.createWorld({ type: 'pvp', capacity: 2 });
check(w1 && w1.id === 'pvp-001', `expected pvp-001, got ${w1 && w1.id}`);
check(w1.settings.capacity === 2, 'capacity override should be respected');

w1.addPlayer('p1');
w1.addPlayer('p2');
check(w1.isFull, 'world should report full at capacity');
check(w1.addPlayer('p3') === null, 'addPlayer should refuse once the world is full');

const assigned = wm.autoAssignPlayer('pvp');
check(assigned.id === 'pvp-002', `expected auto-assignment to create pvp-002, got ${assigned.id}`);

wm.destroyWorld(w1.id);
check(wm.getWorld(w1.id) === undefined, 'destroyed world should no longer be retrievable');
check(wm.getAllWorlds().length === 1, 'only pvp-002 should remain after destroying pvp-001');

for (let i = 0; i < 25; i++) wm.createWorld({ type: 'pvp' });
check(wm.totalWorlds === wm.limits.MAX_WORLDS, `totalWorlds should cap at MAX_WORLDS (${wm.limits.MAX_WORLDS}), got ${wm.totalWorlds}`);
check(wm.createWorld({ type: 'pvp' }) === null, 'createWorld should refuse once MAX_WORLDS is reached');

wm.shutdown();

if (failures === 0) {
  console.log('PASS: world-manager.unit.test.js');
  process.exit(0);
} else {
  console.error(`FAILED: ${failures} assertion(s) did not hold.`);
  process.exit(1);
}
