/**
 * interfaces/MissionInterface.js
 * -----------------------------------------------------------------------
 * NOT IMPLEMENTED. Documents the shape a future mission/objective system
 * (relevant to 'hunt', 'cleansing', and 'extraction' world types) would
 * expose. Per project scope, missions are explicitly excluded -- do not
 * implement these methods.
 *
 * Expected future shape:
 *   class MissionSystem {
 *     startMission(world, missionId) {}
 *     getObjectiveState(world) {}
 *     onPlayerJoin(world, player) {}   // would be wired into HookRegistry
 *     onWorldUpdate(world) {}          // objective/timer progression
 *   }
 * -----------------------------------------------------------------------
 */

class MissionInterface {
  startMission(world, missionId) {
    throw new Error('MissionInterface.startMission is not implemented (out of scope).');
  }
}

module.exports = MissionInterface;
