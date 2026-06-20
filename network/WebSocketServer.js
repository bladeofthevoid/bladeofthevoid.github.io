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
 *     This class knows nothing about Players, Entities, or the
 *     SimulationWorld -- it just hands raw parsed messages upward via
 *     callbacks. That keeps networking and simulation independently
 *     testable and replaceable.
 * -----------------------------------------------------------------------
 */

const WebSocket = require('ws');
const crypto = require('crypto');

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

    // Callback hooks, assigned by server.js. Left null-checked rather than
    // using an event emitter to keep the control flow easy to follow for
    // a project this size; swap for EventEmitter if the hook list grows.
    this.onConnect = null;    // (id) => void
    this.onDisconnect = null; // (id) => void
    this.onMessage = null;    // (id, message) => void

    this.wss.on('connection', (socket) => this._handleConnection(socket));
  }

  _handleConnection(socket) {
    const id = crypto.randomUUID();
    this.clients.set(id, socket);

    socket.on('message', (raw) => {
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
      if (this.onDisconnect) this.onDisconnect(id);
    });

    socket.on('error', () => {
      // 'close' will also fire after 'error' in ws, so cleanup happens there.
    });

    if (this.onConnect) this.onConnect(id);
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

  /** Number of currently-connected sockets. */
  get connectionCount() {
    return this.clients.size;
  }
}

module.exports = GameWebSocketServer;
