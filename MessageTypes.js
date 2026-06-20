/**
 * network/MessageTypes.js
 * -----------------------------------------------------------------------
 * Every WebSocket message has a `type` field set to one of these strings.
 * Centralizing them here (and mirroring the same object literal in
 * index.html) avoids typo bugs like sending 'snapshot' on one side and
 * checking for 'snapshots' on the other.
 *
 * Naming convention: C2S_ = client-to-server, S2C_ = server-to-client.
 * -----------------------------------------------------------------------
 */

module.exports = {
  // --- Client -> Server -------------------------------------------------
  C2S_INPUT: 'input', // a single tick's worth of movement input
  C2S_PING: 'ping',   // latency probe, server echoes it back immediately

  // --- Server -> Client --------------------------------------------------
  S2C_WELCOME: 'welcome',             // sent once, right after connecting
  S2C_SNAPSHOT: 'snapshot',           // periodic authoritative world state
  S2C_PONG: 'pong',                   // reply to C2S_PING
  S2C_PLAYER_JOINED: 'player_joined', // lightweight join notification
  S2C_PLAYER_LEFT: 'player_left',     // lightweight leave notification
};
