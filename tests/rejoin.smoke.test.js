/**
 * tests/rejoin.smoke.test.js
 * -----------------------------------------------------------------------
 * Verifies the reliability/reconnect flow against a REAL world server:
 * connect, move, disconnect, then reconnect within the grace period using
 * the rejoin token from connection_info -- the restored entity should
 * keep its position under a brand-new connection id, proving the server
 * resumed the same Player rather than spawning a fresh one.
 *
 * Requires a world server running on the default port:
 *   SERVER_ID=FRA-01 PORT=8080 node world/WorldServer.js &
 * -----------------------------------------------------------------------
 */

const WebSocket = require('ws');

function connectAndGetInfo(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let connInfo = null;
    let welcome = null;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'connection_info') connInfo = msg;
      if (msg.type === 'welcome') {
        welcome = msg;
        // nudge position so we can verify it's preserved across rejoin
        ws.send(JSON.stringify({ type: 'input', seq: 1, dirX: 1, dirZ: 0 }));
        setTimeout(() => resolve({ ws, connInfo, welcome }), 400);
      }
    });
    ws.on('error', reject);
  });
}

(async () => {
  const first = await connectAndGetInfo('ws://localhost:8080/?worldId=destination-001');
  const myId = first.welcome.id;
  console.log('first session: id=', myId, 'worldId=', first.connInfo.worldId, 'rejoinToken=', first.connInfo.rejoinToken);

  // grab our own latest position from a snapshot before disconnecting
  let lastPos = null;
  await new Promise((resolve) => {
    first.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'snapshot') {
        const me = msg.entities.find((e) => e.id === myId);
        if (me) lastPos = me.position;
      }
    });
    setTimeout(resolve, 300);
  });
  console.log('position before disconnect:', lastPos);

  first.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  const rejoinUrl = `ws://localhost:8080/?worldId=${first.connInfo.worldId}&rejoinToken=${first.connInfo.rejoinToken}`;
  const second = await connectAndGetInfo(rejoinUrl);
  console.log('second session: id=', second.welcome.id, '(different from first:', second.welcome.id !== myId, ')');

  const restoredEntity = second.welcome.snapshot.entities.find((e) => e.id === second.welcome.id);
  console.log('restored entity position:', restoredEntity.position);

  const moved = lastPos && (Math.abs(lastPos.x) > 0.01);
  const positionPreserved =
    restoredEntity && lastPos && Math.abs(restoredEntity.position.x - lastPos.x) < 1.5;

  console.log('moved before disconnect:', moved, '| position roughly preserved on rejoin:', positionPreserved);

  second.ws.close();
  process.exit(positionPreserved ? 0 : 1);
})().catch((err) => {
  console.error('REJOIN TEST FAILED:', err);
  process.exit(1);
});
