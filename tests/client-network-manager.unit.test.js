/**
 * tests/client-network-manager.unit.test.js
 * -----------------------------------------------------------------------
 * Verifies the CLIENT-side NetworkManager class (extracted directly from
 * index.html, see _extractClientModules.js) correctly drives the two-phase
 * gateway -> world handoff:
 *   - connectToGateway() builds the right URL and surfaces S2C_REDIRECT
 *   - the gateway's own intentional post-redirect close must NOT be
 *     reported as a disconnect
 *   - connectToWorld() builds the right URL, captures connection-info/
 *     rejoin-token state, and an UNEXPECTED close of that connection
 *     DOES fire onWorldDisconnected exactly once
 *
 * No real gateway/world server is needed for this test -- see
 * client-network-manager.integration.test.js for the version that runs
 * this same extracted class against the real server stack.
 *
 * Run with: node tests/client-network-manager.unit.test.js
 * -----------------------------------------------------------------------
 */

global.ClientConfig = { PING_INTERVAL_MS: 100000 }; // long enough to not fire mid-test
global.performance = { now: () => Date.now() };

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen();
    }, 5);
  }
  send(data) {
    MockWebSocket.sent.push({ url: this.url, data: JSON.parse(data) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  /** Test-only helper: simulate the remote end pushing a message. */
  _receive(msg) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}
MockWebSocket.OPEN = 1;
MockWebSocket.instances = [];
MockWebSocket.sent = [];
global.WebSocket = MockWebSocket;

const { extractClientNetworkModules } = require('./_extractClientModules');
const { MessageTypes, NetworkManager } = extractClientNetworkModules();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures++;
    console.error('FAIL:', message);
  }
}

(async () => {
  const events = [];
  const net = new NetworkManager();
  net.onRedirect = (msg) => events.push(['redirect', msg]);
  net.onConnectionInfo = (msg) => events.push(['connection_info', msg]);
  net.onWelcome = (msg) => events.push(['welcome', msg]);
  net.onSnapshot = (msg) => events.push(['snapshot', msg]);
  net.onWorldDisconnected = () => events.push(['world_disconnected']);

  // --- Phase 1: gateway ---
  net.connectToGateway('ws://localhost:9000', 'pvp');
  await wait(10);
  const gwSocket = MockWebSocket.instances[0];
  check(gwSocket.url === 'ws://localhost:9000/?type=pvp', `gateway URL should carry requested type, got ${gwSocket.url}`);

  gwSocket._receive({ type: MessageTypes.S2C_REDIRECT, serverId: 'FRA-01', worldId: 'pvp-001', worldType: 'pvp', wsUrl: 'ws://localhost:8080', tickRate: 30 });
  gwSocket.close(); // the gateway closes itself right after redirect, by design

  await wait(10);
  check(events.some((e) => e[0] === 'redirect'), 'expected a redirect event');
  check(!events.some((e) => e[0] === 'world_disconnected'), "the gateway's own close must NOT trigger onWorldDisconnected");

  // --- Phase 2: world ---
  net.connectToWorld('ws://localhost:8080', 'pvp-001');
  await wait(10);
  const worldSocket = MockWebSocket.instances[1];
  check(worldSocket.url === 'ws://localhost:8080/?worldId=pvp-001', `world URL should carry worldId, got ${worldSocket.url}`);

  worldSocket._receive({ type: MessageTypes.S2C_CONNECTION_INFO, serverId: 'FRA-01', worldId: 'pvp-001', worldType: 'pvp', tickRate: 30, rejoinToken: 'tok-123' });
  check(net.rejoinToken === 'tok-123', 'NetworkManager should capture the rejoin token from connection_info');

  worldSocket._receive({
    type: MessageTypes.S2C_WELCOME,
    id: 'player-abc',
    config: { movement: {}, serverTickRate: 30, snapshotRate: 20, worldBounds: 50 },
    snapshot: { entities: [], players: {} },
  });
  check(net.localId === 'player-abc', 'NetworkManager should capture localId from welcome');

  worldSocket._receive({ type: MessageTypes.S2C_SNAPSHOT, tick: 5, entities: [], players: {}, capacity: 16, tps: 29.8 });
  check(events.some((e) => e[0] === 'snapshot'), 'expected a snapshot event');

  net.sendInput({ seq: 1, dirX: 1, dirZ: 0 });
  check(
    MockWebSocket.sent.some((s) => s.url === worldSocket.url && s.data.type === 'input'),
    'sendInput should send over the world socket'
  );

  // --- Unexpected world drop ---
  worldSocket.close();
  await wait(10);
  check(
    events.filter((e) => e[0] === 'world_disconnected').length === 1,
    'an unexpected world-connection close should fire onWorldDisconnected exactly once'
  );

  console.log('Event sequence:', events.map((e) => e[0]).join(' -> '));
  if (failures === 0) {
    console.log('PASS: client-network-manager.unit.test.js');
    process.exit(0);
  } else {
    console.error(`FAILED: ${failures} assertion(s) did not hold.`);
    process.exit(1);
  }
})();
