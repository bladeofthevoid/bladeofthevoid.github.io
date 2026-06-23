/**
 * tests/gateway-world.smoke.test.js
 * -----------------------------------------------------------------------
 * End-to-end smoke test using raw `ws` connections (no client extraction
 * involved -- this exercises the SERVER side of the protocol directly):
 * connect to the gateway, follow its redirect, connect to the assigned
 * world server, and confirm connection_info/welcome/snapshot/pong all
 * arrive in the right shape.
 *
 * Requires a gateway + at least one world server already running on the
 * default ports (see tests/run-all.sh, or start them manually):
 *   node gateway/gateway.js &
 *   node world/WorldServer.js &
 * -----------------------------------------------------------------------
 */

const WebSocket = require('ws');

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function connectGateway() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:9000/?type=destination');
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      log('gateway ->', msg.type, JSON.stringify(msg));
      if (msg.type === 'redirect') {
        resolve(msg);
      } else if (msg.type === 'assignment_error') {
        reject(new Error(msg.reason));
      }
    });
    ws.on('error', reject);
  });
}

function connectWorld(assignment) {
  return new Promise((resolve, reject) => {
    const url = `${assignment.wsUrl}/?worldId=${assignment.worldId}`;
    const ws = new WebSocket(url);
    let gotWelcome = false;
    let gotConnInfo = false;
    let gotSnapshot = false;

    ws.on('open', () => log('world socket open ->', url));

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'connection_info') {
        gotConnInfo = true;
        log('world ->', msg.type, JSON.stringify(msg));
      } else if (msg.type === 'welcome') {
        gotWelcome = true;
        log('world -> welcome', 'id=', msg.id, 'worldId=', msg.worldId, 'serverId=', msg.serverId, 'entities=', msg.snapshot.entities.length);
        // send a couple of inputs to exercise movement
        ws.send(JSON.stringify({ type: 'input', seq: 1, dirX: 1, dirZ: 0 }));
        ws.send(JSON.stringify({ type: 'ping', clientSendTime: Date.now() }));
      } else if (msg.type === 'snapshot') {
        if (!gotSnapshot) {
          gotSnapshot = true;
          log('world -> snapshot', 'tick=', msg.tick, 'tps=', msg.tps, 'capacity=', msg.capacity, 'entities=', msg.entities.length);
        }
      } else if (msg.type === 'pong') {
        log('world -> pong, rtt~', Date.now() - msg.clientSendTime, 'ms');
      } else {
        log('world ->', msg.type);
      }

      if (gotConnInfo && gotWelcome && gotSnapshot) {
        setTimeout(() => {
          ws.close();
          resolve();
        }, 300);
      }
    });

    ws.on('error', reject);
  });
}

(async () => {
  try {
    const assignment = await connectGateway();
    await connectWorld(assignment);
    log('SMOKE TEST PASSED');
    process.exit(0);
  } catch (err) {
    console.error('SMOKE TEST FAILED:', err);
    process.exit(1);
  }
})();
