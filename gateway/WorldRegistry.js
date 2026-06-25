/**
 * gateway/WorldRegistry.js
 * -----------------------------------------------------------------------
 * The gateway's source of truth for "which server instances exist, and
 * what worlds/populations do they currently report". Pure bookkeeping --
 * this class never talks to a player, never simulates anything, and
 * never reaches into a World object. It only knows the shape that world
 * servers self-report over HTTP (see world/WorldServer.js's
 * registerWithGateway/sendHeartbeat).
 *
 * Reliability: a server that stops heartbeating is evicted after
 * GATEWAY.SERVER_TIMEOUT_MS. Evicting it removes its worlds from the
 * registry too, which is what stops the gateway from ever assigning a
 * new player into a world hosted by a server instance that's actually
 * dead -- "prevent orphan worlds" from the gateway's point of view.
 * -----------------------------------------------------------------------
 */

const https  = require('https');
const http   = require('http');

const Config = require('../config/constants');

/**
 * Fire-and-forget GET to `url`. Resolves true on any HTTP response,
 * false on network error or timeout. Used only for keep-alive pings —
 * we don't care about the response body, just that the server woke up.
 */
function ping(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    try {
      const req = mod.get(url, (res) => { res.resume(); resolve(true); });
      req.setTimeout(12000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch (_) { resolve(false); }
  });
}

class WorldRegistry {
  constructor() {
    /** @type {Map<string, object>} serverId -> { serverId, adminUrl, wsUrl, maxWorlds, maxPlayers, maxEntities, supportedTypes, lastHeartbeatAt, worlds: [] } */
    this.servers = new Map();

    /**
     * Every admin URL we have ever seen, even from servers that have since
     * been evicted. Kept so the keep-alive pinger can still reach them
     * after a spin-down (the process died, so it can't heartbeat, but an
     * HTTP GET to its admin URL will wake it back up).
     * @type {Set<string>}
     */
    this.knownAdminUrls = new Set();

    this._sweepTimer    = setInterval(() => this._evictStaleServers(), Config.GATEWAY.HEARTBEAT_INTERVAL_MS);
    this._keepAliveTimer = null;
  }

  /**
   * Start periodic pings to all known world-server admin URLs so Render's
   * free-plan services never idle out.
   *
   * @param {string[]} initialUrls  Static list from GATEWAY env var —
   *   used to prime the set before any server has self-registered.
   * @param {number}   intervalMs   How often to ping (default 10 min).
   */
  startKeepAlive(initialUrls = [], intervalMs = Config.KEEP_ALIVE.PING_INTERVAL_MS) {
    for (const url of initialUrls) {
      if (url) this.knownAdminUrls.add(url);
    }

    // Ping immediately on gateway startup so world servers wake up as
    // soon as the gateway itself comes back from a cold start.
    setTimeout(() => this._pingAll(), 5_000);

    this._keepAliveTimer = setInterval(() => this._pingAll(), intervalMs);
    console.log(
      `[gateway/keep-alive] pinging ${this.knownAdminUrls.size} known server(s) every ${intervalMs / 60000} min`
    );
  }

  /** Send a lightweight ping to every known admin URL. */
  async _pingAll() {
    if (this.knownAdminUrls.size === 0) return;
    for (const adminUrl of this.knownAdminUrls) {
      const target = `${adminUrl}/admin/status`;
      ping(target).then((ok) => {
        if (ok) console.log(`[gateway/keep-alive] ✓ ${adminUrl}`);
        else    console.warn(`[gateway/keep-alive] ✗ unreachable: ${adminUrl}`);
      });
    }
  }

  /** Called when a world server starts up and announces itself. */
  registerServer(info) {
    // Persist the admin URL so the keep-alive pinger can reach this server
    // even if it goes idle and is later evicted from the live registry.
    if (info.adminUrl) this.knownAdminUrls.add(info.adminUrl);

    const existing = this.servers.get(info.serverId);
    this.servers.set(info.serverId, {
      serverId: info.serverId,
      adminUrl: info.adminUrl,
      wsUrl: info.wsUrl,
      maxWorlds: info.maxWorlds,
      maxPlayers: info.maxPlayers,
      maxEntities: info.maxEntities,
      supportedTypes: info.supportedTypes || [],
      lastHeartbeatAt: Date.now(),
      worlds: existing ? existing.worlds : [],
    });
  }

  /**
   * Called on every heartbeat. If this server somehow heartbeats before
   * its registration is known to us (e.g. gateway restarted), this
   * defensively upserts a registration from the heartbeat payload itself
   * rather than dropping useful data on the floor.
   */
  updateHeartbeat(status) {
    const existing = this.servers.get(status.serverId);
    if (!existing) {
      this.registerServer({
        serverId: status.serverId,
        adminUrl: status.adminUrl || null,
        wsUrl: status.wsUrl || null,
        maxWorlds: status.maxWorlds,
        maxPlayers: status.maxPlayers,
        maxEntities: status.maxEntities,
        supportedTypes: status.supportedTypes || [],
      });
    }
    const server = this.servers.get(status.serverId);
    server.maxWorlds = status.maxWorlds;
    server.maxPlayers = status.maxPlayers;
    server.maxEntities = status.maxEntities;
    server.worlds = status.worlds || [];
    server.lastHeartbeatAt = Date.now();
  }

  removeServer(serverId) {
    return this.servers.delete(serverId);
  }

  getServer(serverId) {
    return this.servers.get(serverId);
  }

  getAllServers() {
    return Array.from(this.servers.values());
  }

  /** Total players this server is currently reporting across all its worlds. */
  _serverPlayerCount(server) {
    return server.worlds.reduce((sum, w) => sum + (w.players || 0), 0);
  }

  /**
   * Finds an existing world of `type`, on any known-alive server, that
   * still has room for one more player. Returns { server, world } or null.
   */
  findWorldWithCapacity(type) {
    for (const server of this.servers.values()) {
      for (const world of server.worlds) {
        if (world.type === type && world.players < world.capacity) {
          return { server, world };
        }
      }
    }
    return null;
  }

  /**
   * Picks the least-loaded server that supports `type` and has room to
   * host one more world, for AssignmentService to ask to create one.
   * Returns the server record, or null if every known server is at
   * MAX_WORLDS or MAX_PLAYERS.
   */
  findServerWithRoomForNewWorld(type) {
    const candidates = this.getAllServers().filter(
      (s) =>
        (s.supportedTypes.length === 0 || s.supportedTypes.includes(type)) &&
        s.worlds.length < s.maxWorlds &&
        this._serverPlayerCount(s) < s.maxPlayers
    );
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => this._serverPlayerCount(a) / a.maxPlayers - this._serverPlayerCount(b) / b.maxPlayers);
    return candidates[0];
  }

  /** Debug/inspection snapshot for GET /gateway/status. */
  getStatusSnapshot() {
    return {
      servers: this.getAllServers().map((s) => ({
        serverId: s.serverId,
        wsUrl: s.wsUrl,
        worlds: s.worlds,
        totalPlayers: this._serverPlayerCount(s),
        maxPlayers: s.maxPlayers,
        maxWorlds: s.maxWorlds,
        ageMs: Date.now() - s.lastHeartbeatAt,
      })),
    };
  }

  _evictStaleServers() {
    const now = Date.now();
    for (const server of this.servers.values()) {
      if (now - server.lastHeartbeatAt > Config.GATEWAY.SERVER_TIMEOUT_MS) {
        console.warn(`[gateway] evicting unresponsive server ${server.serverId} (no heartbeat)`);
        this.servers.delete(server.serverId);
      }
    }
  }

  shutdown() {
    clearInterval(this._sweepTimer);
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
  }
}

module.exports = WorldRegistry;
