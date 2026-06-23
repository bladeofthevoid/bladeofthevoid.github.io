/**
 * gateway/AssignmentService.js
 * -----------------------------------------------------------------------
 * Decides which (server, world) a newly-connecting player should be sent
 * to. This is the ONLY place in the gateway that makes a placement
 * decision -- gateway.js just calls assign() and relays the result.
 *
 * Flow:
 *   1. Look for an existing world of the requested type, on any known
 *      live server, that still has room (WorldRegistry.findWorldWithCapacity).
 *   2. If none exists, find the least-loaded server that can host a new
 *      world of that type (WorldRegistry.findServerWithRoomForNewWorld)
 *      and ask IT to create one via its admin HTTP API -- this is the
 *      "Destination full -> create Destination-02" behavior, just
 *      initiated from the gateway side because the gateway is the thing
 *      that knows population across ALL instances, not any one of them.
 *   3. If no server can host a new world either, assignment fails and the
 *      caller (gateway.js) tells the client so.
 *
 * The gateway itself never touches a World, an EntityManager, or a
 * MovementSystem -- "Gateway should NOT simulate gameplay" holds because
 * this file's only verbs are "ask the registry" and "ask a remote admin
 * API", never "compute a tick".
 * -----------------------------------------------------------------------
 */

const Config = require('../config/constants');
const { postJson } = require('../shared/httpJson');

class AssignmentService {
  /** @param {WorldRegistry} registry */
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * @param {{ type?: string }} request
   * @returns {Promise<{serverId, worldId, worldType, wsUrl, tickRate} | null>}
   *   null means "could not place this player anywhere right now".
   */
  async assign({ type } = {}) {
    const resolvedType = Config.WORLD_TYPES[type] ? type : Config.DEFAULT_WORLD_TYPE;

    const existing = this.registry.findWorldWithCapacity(resolvedType);
    if (existing) {
      // Optimistic local increment so a burst of simultaneous joins
      // doesn't all read "room for one more" and over-fill the same
      // world before the next heartbeat corrects the count.
      existing.world.players += 1;
      return this._toAssignment(existing.server, existing.world.id, resolvedType);
    }

    const server = this.registry.findServerWithRoomForNewWorld(resolvedType);
    if (!server) return null;

    let created;
    try {
      created = await postJson(`${server.adminUrl}/admin/worlds`, { type: resolvedType });
    } catch (err) {
      console.warn(`[gateway] failed to create world on ${server.serverId}: ${err.message}`);
      return null;
    }

    // Same optimistic-bookkeeping reasoning as above: reflect the new
    // world locally right away rather than waiting for the next heartbeat.
    server.worlds.push({
      id: created.worldId,
      type: resolvedType,
      players: 1,
      capacity: created.capacity,
      entities: 0,
      tick: 0,
      tps: 0,
    });

    return this._toAssignment(server, created.worldId, resolvedType);
  }

  _toAssignment(server, worldId, worldType) {
    return {
      serverId: server.serverId,
      worldId,
      worldType,
      wsUrl: server.wsUrl,
      tickRate: Config.SERVER_TICK_RATE,
    };
  }
}

module.exports = AssignmentService;
