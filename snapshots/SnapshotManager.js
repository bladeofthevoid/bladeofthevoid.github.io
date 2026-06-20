/**
 * snapshots/SnapshotManager.js
 * -----------------------------------------------------------------------
 * Builds the payload broadcast to every client at SNAPSHOT_RATE (20Hz),
 * which is intentionally a different rate than the simulation's tick rate
 * (30Hz, see SimulationWorld). The simulation can advance fidelity
 * independently of how often state actually goes over the wire.
 *
 * Snapshot shape:
 *   {
 *     type: 'snapshot',
 *     tick: <server tick this snapshot was built at>,
 *     serverTime: <Date.now(), informational/debugging only>,
 *     entities: [ Entity.serialize(), ... ],   // every entity's full state
 *     players: { [playerId]: { lastProcessedInputSeq } }
 *   }
 *
 * `players[id].lastProcessedInputSeq` is what lets each client's own
 * Predictor know which of its buffered inputs the server has already
 * incorporated, and therefore which it can stop replaying during
 * reconciliation (see index.html, Predictor.reconcile).
 * -----------------------------------------------------------------------
 */

const MessageTypes = require('../network/MessageTypes');

class SnapshotManager {
  constructor(entityManager, simulationWorld) {
    this.entityManager = entityManager;
    this.simulationWorld = simulationWorld;
  }

  buildSnapshot() {
    const entities = this.entityManager.getAllEntities().map((e) => e.serialize());

    const players = {};
    for (const player of this.entityManager.getEntitiesByType('player')) {
      players[player.id] = { lastProcessedInputSeq: player.lastProcessedInputSeq };
    }

    return {
      type: MessageTypes.S2C_SNAPSHOT,
      tick: this.simulationWorld.currentTick,
      serverTime: Date.now(),
      entities,
      players,
    };
  }
}

module.exports = SnapshotManager;
