/**
 * tests/client-network-manager.integration.test.js
 * -----------------------------------------------------------------------
 * Same extracted client NetworkManager class as
 * client-network-manager.unit.test.js, but driven against a REAL gateway
 * + world server pair over real WebSocket connections (via the `ws`
 * package standing in for the browser's native WebSocket).
 *
 * Requires a gateway and at least one world server already running.
 * The simplest way to run this exactly as written:
 *
 *   node gateway/gateway.js &
 *   SERVER_ID=FRA-01 PORT=8080 node world/WorldServer.js &
 *   sleep 1
 *   node tests/client-network-manager.integration.test.js
 *
 * (See tests/run-all.sh, which does exactly this and cleans up after.)
 * -----------------------------------------------------------------------
 */

global.ClientConfig = { PING_INTERVAL_MS: 100000 };
global.performance = { now: () => Date.now() };
global.WebSocket = require('ws');

const { extractClientNetworkModules } = require('./_extractClientModules');
const { NetworkManager } = extractClientNetworkModules();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const net = new NetworkManager();
  const seen = [];

  net.onRedirect = (assignment) => {
    seen.push('redirect');
    console.log('  redirect ->', assignment.serverId, assignment.worldId, assignment.worldType);
    net.connectToWorld(assignment.wsUrl, assignment.worldId);
  };
  net.onConnectionInfo = () => {
    seen.push('connection_info');
    console.log('  connection_info -> serverId=', net.serverId, 'worldId=', net.worldId, 'rejoinToken set:', !!net.rejoinToken);
  };
  net.onWelcome = (msg) => {
    seen.push('welcome');
    console.log('  welcome -> localId=', net.localId, 'entities in snapshot=', msg.snapshot.entities.length);
    net.sendInput({ seq: 1, dirX: 1, dirZ: 0 });
  };
  net.onSnapshot = (msg) => {
    if (!seen.includes('snapshot')) {
      seen.push('snapshot');
      console.log('  snapshot -> tick=', msg.tick, 'tps=', msg.tps, 'capacity=', msg.capacity);
    }
  };

  net.connectToGateway(process.env.GATEWAY_URL || 'ws://localhost:9000', 'hunt');

  await wait(1500);

  const expected = ['redirect', 'connection_info', 'welcome', 'snapshot'];
  const ok = expected.every((e) => seen.includes(e));
  console.log('Sequence seen:', seen.join(' -> '));
  console.log(ok ? 'PASS: client-network-manager.integration.test.js' : 'FAILED: client-network-manager.integration.test.js');
  net._teardownSocket();
  process.exit(ok ? 0 : 1);
})();
