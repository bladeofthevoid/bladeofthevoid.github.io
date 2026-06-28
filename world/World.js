/**
 * world/World.js
 * -----------------------------------------------------------------------
 * One fully isolated game world: { id, type, players, entities, tick,
 * settings }, exactly as specified. A World owns its own EntityManager
 * and SnapshotManager and is responsible for the movement-simulation work
 * that used to live in simulation/SimulationWorld.js -- the MovementSystem
 * math itself is byte-for-byte unchanged (see simulation/MovementSystem.js),
 * only "what calls it, for whose entities" has moved.
 *
 * Isolation guarantee: a World never reaches into another World's state.
 * It has no reference to WorldManager, the gateway, or any other World.
 * The only things it knows about are its own EntityManager, its own
 * SnapshotManager, and the shared, stateless MovementSystem/Config
 * modules. That's what "no shared gameplay state" means concretely.
 *
 * Server authority, prediction, reconciliation: unchanged. Clients still
 * only ever send an input direction (see queueInput), the server is still
 * the only thing that computes a position, and tick() still always
 * advances by a fixed dt, never a client-reported delta-time.
 * -----------------------------------------------------------------------
 */

const crypto = require('crypto');

const Config = require('../config/constants');
const MovementSystem = require('../simulation/MovementSystem');
const EntityManager = require('./EntityManager');
const SnapshotManager = require('./SnapshotManager');
const Player = require('../entities/Player');
const HookRegistry = require('../interfaces/HookRegistry');

class World {
  /**
   * @param {object} opts
   * @param {string} opts.id - e.g. 'destination-001'
   * @param {string} opts.type - one of Config.WORLD_TYPES' keys
   * @param {string} opts.serverId - the hosting server instance's id, e.g. 'FRA-01'
   * @param {object} [opts.settings] - { capacity, maxEntities, bounds, tickRate }, defaults from Config.WORLD_TYPES[type]
   * @param {HookRegistry} [opts.hooks] - extensibility seam, see interfaces/HookRegistry.js
   * @param {PersistenceManager} [opts.persistence] - placeholder, see persistence/PersistenceManager.js
   */
  constructor({ id, type, serverId, settings, hooks, persistence }) {
    const typeDefaults = Config.WORLD_TYPES[type] || Config.WORLD_TYPES[Config.DEFAULT_WORLD_TYPE];

    this.id = id;
    this.type = type;
    this.serverId = serverId;
    this.settings = {
      capacity: typeDefaults.capacity,
      maxEntities: typeDefaults.maxEntities,
      bounds: Config.WORLD.BOUNDS,
      tickRate: Config.SERVER_TICK_RATE,
      ...settings,
    };

    this.entityManager = new EntityManager();
    this.snapshotManager = new SnapshotManager(this.entityManager, this);
    this.hooks = hooks || new HookRegistry();
    this.persistence = persistence || null;

    /** @type {Map<string, Player>} connection id -> Player entity currently in this world */
    this.players = new Map();

    /** @type {Map<string, {player: Player, disconnectedAt: number}>} rejoin token -> recently-disconnected session */
    this.pendingRejoin = new Map();

    this.currentTick = 0;
    this.fixedDt = 1 / this.settings.tickRate;

    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();

    this.measuredTps = this.settings.tickRate;
    this._tpsWindowStart = Date.now();
    this._tpsTickCount = 0;

    this.hooks.onWorldCreated(this);
  }

  get playerCount() {
    return this.players.size;
  }

  get entityCount() {
    return this.entityManager.count;
  }

  get isFull() {
    return this.playerCount >= this.settings.capacity;
  }

  get isEmpty() {
    return this.playerCount === 0;
  }

  /** Spawns players spread around the origin instead of stacked on top of each other. */
  _randomSpawnPoint() {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * Config.SPAWN.RADIUS;
    return {
      x: Math.cos(angle) * radius,
      y: 0,
      z: Math.sin(angle) * radius,
    };
  }

  /**
   * Adds a brand-new player connection to this world. Returns the created
   * Player entity, or null if the world is already full (capacity
   * management -- callers, e.g. WorldServer, should check `isFull` before
   * calling this, but World defends itself too).
   */
  addPlayer(connectionId) {
    if (this.isFull) return null;
    if (this.entityCount >= this.settings.maxEntities) return null;

    const player = new Player(connectionId, this._randomSpawnPoint());
    player.worldId = this.id;
    player.rejoinToken = crypto.randomUUID();

    this.entityManager.addEntity(player);
    this.players.set(connectionId, player);
    this.lastActivityAt = Date.now();

    this.hooks.onEntitySpawn(this, player);
    this.hooks.onPlayerJoin(this, player);

    return player;
  }

  /**
   * Resumes a recently-disconnected session under a NEW connection id
   * (every fresh WebSocket connection gets a new id from
   * GameWebSocketServer, even when it's "the same player" reconnecting).
   * Returns the restored Player, or null if the token is unknown/expired
   * -- callers should treat null as "this is actually a new join".
   */
  rejoinPlayer(newConnectionId, rejoinToken) {
    const pending = this.pendingRejoin.get(rejoinToken);
    if (!pending) return null;

    const age = Date.now() - pending.disconnectedAt;
    this.pendingRejoin.delete(rejoinToken);
    if (age > Config.RELIABILITY.REJOIN_GRACE_MS) return null;
    if (this.isFull) return null;

    const player = pending.player;
    player.id = newConnectionId;
    player.rejoinToken = crypto.randomUUID();

    this.entityManager.addEntity(player);
    this.players.set(newConnectionId, player);
    this.lastActivityAt = Date.now();

    this.hooks.onEntitySpawn(this, player);
    this.hooks.onPlayerJoin(this, player);

    return player;
  }

  /**
   * Removes a player connection from this world. By default the entity
   * is kept around for RELIABILITY.REJOIN_GRACE_MS under its rejoin
   * token so a quick reconnect resumes the same entity (see
   * rejoinPlayer); pass allowRejoin:false for a deliberate leave (not
   * currently triggered by anything client-side, but kept as the honest
   * "really gone" path for a future "leave world" UI action).
   */
  removePlayer(connectionId, { allowRejoin = true } = {}) {
    const player = this.players.get(connectionId);
    if (!player) return null;

    this.players.delete(connectionId);
    this.entityManager.removeEntity(connectionId);
    this.lastActivityAt = Date.now();

    this.hooks.onPlayerLeave(this, player);
    this.hooks.onEntityRemove(this, player);

    if (this.persistence) {
      // Fire-and-forget -- PersistenceManager is a no-op placeholder
      // today (see persistence/PersistenceManager.js), but the call site
      // is wired so a real implementation later doesn't require touching
      // World.js.
      this.persistence.savePlayerState(player.id, player.serialize()).catch(() => {});
    }

    if (allowRejoin) {
      this.pendingRejoin.set(player.rejoinToken, { player, disconnectedAt: Date.now() });
    }

    return player;
  }

  /**
   * Generic entity spawn hook for future self-driving entities (Enemy,
   * Projectile -- see interfaces/EnemySystem.js, interfaces/ProjectileSystem.js).
   * Nothing calls this yet; it exists so adding a spawner later is
   * additive rather than requiring changes to World.js itself.
   */
  spawnEntity(entity) {
    if (this.entityCount >= this.settings.maxEntities) return null;
    entity.worldId = this.id;
    this.entityManager.addEntity(entity);
    this.hooks.onEntitySpawn(this, entity);
    return entity;
  }

  removeEntity(id) {
    const entity = this.entityManager.getEntity(id);
    if (!entity) return null;
    this.entityManager.removeEntity(id);
    this.hooks.onEntityRemove(this, entity);
    return entity;
  }

  /**
   * Called by the network layer whenever an 'input' message arrives for
   * one of this world's players. Does NOT apply the input immediately --
   * it's queued and consumed by the next update() call, which is what
   * keeps movement locked to this world's tick rate instead of to packet
   * arrival timing. Identical defensive clamping to the original
   * SimulationWorld.queueInput.
   */
  queueInput(connectionId, input) {
    const player = this.players.get(connectionId);
    if (!player) return;

    const dirX = clamp(Number(input.dirX) || 0, -1, 1);
    const dirZ = clamp(Number(input.dirZ) || 0, -1, 1);
    const seq = Number.isFinite(input.seq) ? input.seq : player.lastProcessedInputSeq;

    // Allowlist the locomotion phase string coming from the client.
    // Only the three known values are forwarded; anything else (missing,
    // null, unknown string) becomes undefined so MovementSystem falls
    // back to RUN_SPEED — safe, conservative, and cheat-resistant.
    const VALID_PHASES = new Set(['drift', 'run', 'breakstride']);
    const phase = VALID_PHASES.has(input.phase) ? input.phase : undefined;

    player.inputQueue.push({ dirX, dirZ, seq, phase });

    if (player.inputQueue.length > Config.LIMITS.MAX_QUEUED_INPUTS_PER_PLAYER) {
      player.inputQueue.shift();
    }
  }

  /**
   * Advances THIS world by exactly one fixed simulation tick. Called by
   * SimulationLoop once per tick for every world on this server instance
   * (`for (world of worlds) world.update()`, per the architecture brief)
   * -- nothing here knows or cares that other worlds exist.
   */
  update() {
    this.currentTick++;

    for (const player of this.entityManager.getEntitiesByType('player')) {
      const input = player.inputQueue.shift();

      if (input) {
        player.lastProcessedInputSeq = input.seq;
      }
      // Input starvation (client lagging / packet loss): fall back to "no
      // input" rather than repeating the last direction.
      const effectiveInput = input || { dirX: 0, dirZ: 0 };

      MovementSystem.step(player, effectiveInput, this.fixedDt, Config.MOVEMENT);

      // Simple world-bounds clamp, per-world so a future world type could
      // configure a different arena size via settings.bounds.
      player.position.x = clamp(player.position.x, -this.settings.bounds, this.settings.bounds);
      player.position.z = clamp(player.position.z, -this.settings.bounds, this.settings.bounds);

      player.tick = this.currentTick;
    }

    // Hook for future self-updating entities (enemy AI, projectile
    // flight). No-op today since only Player entities exist.
    this.entityManager.update(this.fixedDt);

    this.hooks.onWorldUpdate(this);
    this._recomputeTps();
  }

  _recomputeTps() {
    this._tpsTickCount++;
    const now = Date.now();
    const elapsed = now - this._tpsWindowStart;
    if (elapsed >= 1000) {
      this.measuredTps = (this._tpsTickCount * 1000) / elapsed;
      this._tpsTickCount = 0;
      this._tpsWindowStart = now;
    }
  }

  /** Removes rejoin sessions that have outlived their grace period. */
  gcExpiredRejoinSessions() {
    const now = Date.now();
    for (const [token, pending] of this.pendingRejoin.entries()) {
      if (now - pending.disconnectedAt > Config.RELIABILITY.REJOIN_GRACE_MS) {
        this.pendingRejoin.delete(token);
      }
    }
  }

  buildSnapshot() {
    return this.snapshotManager.buildSnapshot();
  }

  /** Compact status used for admin/heartbeat reporting -- never sent verbatim to game clients. */
  serializeStatus() {
    return {
      id: this.id,
      type: this.type,
      players: this.playerCount,
      capacity: this.settings.capacity,
      entities: this.entityCount,
      tick: this.currentTick,
      tps: Math.round(this.measuredTps * 10) / 10,
    };
  }

  /** Called once by WorldManager right before this world is dropped. */
  destroy() {
    this.hooks.onWorldDestroy(this);
    this.players.clear();
    this.pendingRejoin.clear();
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = World;
