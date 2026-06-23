/**
 * network/WebSocketServer.js
 * -----------------------------------------------------------------------
 * Wraps the raw `ws` library so the rest of the codebase never touches a
 * WebSocket directly. This is the ONLY file allowed to import 'ws'.
 *
 * Why a wrapper at all:
 *   - Keeps the wire format (JSON.stringify/parse) in one place. If this
 *     project later swaps to a binary protocol for bandwidth reasons,
 *     only this file changes.
 *   - Decouples "a message arrived" from "what the game does about it".
 *     This class knows nothing about Players, Entities, Worlds, or the
 *     SimulationLoop -- it just hands raw parsed messages upward via
 *     callbacks. That keeps networking and simulation independently
 *     testable and replaceable. The gateway and every world server reuse
 *     this exact same class.
 *
 * Multi-instance additions (both purely additive -- send/broadcast/parse
 * behavior for an already-open connection is unchanged):
 *   1. onConnect now also receives the parsed query string from the
 *      connection URL (e.g. `?worldId=destination-001&rejoinToken=...`),
 *      because a world server needs to know *which world* a redirected
 *      client is trying to join before it has sent its first message.
 *   2. A periodic stale-connection sweep closes sockets that have sent
 *      nothing (not even a ping) for RELIABILITY.CONNECTION_TIMEOUT_MS,
 *      so a dropped connection that never fires a TCP 'close' event
 *      (common on mobile networks) doesn't leave an orphaned player/world
 *      slot occupied forever.
 * -----------------------------------------------------------------------
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const { URL } = require('url');
const Config = require('../config/constants');

class GameWebSocketServer {
  /**
   * @param {http.Server} httpServer - an existing HTTP server to attach to.
   *   Reusing one HTTP server for both static file serving and the WS
   *   upgrade keeps deployment simple (one port, one process).
   */
  constructor(httpServer) {
    this.wss = new WebSocket.Server({ server: httpServer });

    /** @type {Map<string, WebSocket>} connection id -> socket */
    this.clients = new Map();

    /** @type {Map<string, number>} connection id -> last time we heard anything from it */
    this._lastSeen = new Map();

    // Callback hooks, assigned by the owning server (gateway.js or
    // WorldServer.js). Left null-checked rather than using an event
    // emitter to keep the control flow easy to follow for a project this
    // size; swap for EventEmitter if the hook list grows.
    this.onConnect = null;    // (id, query) => void
    this.onDisconnect = null; // (id, reason) => void
    this.onMessage = null;    // (id, message) => void

    this.wss.on('connection', (socket, request) => this._handleConnection(socket, request));

    this._sweepTimer = setInterval(
      () => this._sweepStaleConnections(),
      Config.RELIABILITY.CONNECTION_SWEEP_INTERVAL_MS
    );
  }

  _handleConnection(socket, request) {
    const id = crypto.randomUUID();
    this.clients.set(id, socket);
    this._lastSeen.set(id, Date.now());

    // Parse the connection URL's query string (e.g. ?worldId=...&type=...)
    // so the caller can route this connection before any message arrives.
    // Falls back to an empty object if the URL is somehow unparsable --
    // a malformed connection URL should never crash the server.
    let query = {};
    try {
      const parsed = new URL(request.url, 'http://placeholder');
      query = Object.fromEntries(parsed.searchParams.entries());
    } catch (err) {
      query = {};
    }

    socket.on('message', (raw) => {
      this._lastSeen.set(id, Date.now());
      let message;
      try {
        message = JSON.parse(raw);
      } catch (err) {
        // Malformed JSON from a client is not fatal to the server --
        // just drop the message and keep the connection alive.
        return;
      }
      if (this.onMessage) this.onMessage(id, message);
    });

    socket.on('close', () => {
      this.clients.delete(id);
      this._lastSeen.delete(id);
      if (this.onDisconnect) this.onDisconnect(id, 'closed');
    });

    socket.on('error', () => {
      // 'close' will also fire after 'error' in ws, so cleanup happens there.
    });

    if (this.onConnect) this.onConnect(id, query);
  }

  /** Send one JSON-serializable object to a single client. */
  send(id, data) {
    const socket = this.clients.get(id);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  /** Send one JSON-serializable object to every connected client. */
  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const socket of this.clients.values()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  /**
   * Send one JSON-serializable object to a specific subset of clients.
   * Used to broadcast a world's snapshot only to players inside that
   * world, instead of every client connected to this server instance
   * (which may be hosting many isolated worlds at once).
   */
  sendToMany(ids, data) {
    const payload = JSON.stringify(data);
    for (const id of ids) {
      const socket = this.clients.get(id);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  /** Forcibly closes a connection (e.g. world full, assignment error). */
  close(id, code, reason) {
    const socket = this.clients.get(id);
    if (socket) {
      try {
        socket.close(code, reason);
      } catch (err) {
        // Already closing/closed -- nothing to do.
      }
    }
  }

  /**
   * Closes any connection that has sent nothing -- not even a ping --
   * within RELIABILITY.CONNECTION_TIMEOUT_MS. This is what catches
   * connections that died without a clean TCP close (the normal
   * onDisconnect/'close' path still handles everything else).
   */
  _sweepStaleConnections() {
    const now = Date.now();
    const timeout = Config.RELIABILITY.CONNECTION_TIMEOUT_MS;
    for (const [id, lastSeen] of this._lastSeen.entries()) {
      if (now - lastSeen > timeout) {
        const socket = this.clients.get(id);
        this.clients.delete(id);
        this._lastSeen.delete(id);
        if (socket) {
          try {
            socket.terminate();
          } catch (err) {
            // Already gone -- fine.
          }
        }
        if (this.onDisconnect) this.onDisconnect(id, 'timeout');
      }
    }
  }

  /** Number of currently-connected sockets. */
  get connectionCount() {
    return this.clients.size;
  }
}

module.exports = GameWebSocketServer;
