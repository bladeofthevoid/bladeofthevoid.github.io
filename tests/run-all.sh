#!/usr/bin/env bash
# tests/run-all.sh
# ---------------------------------------------------------------------------
# Runs the full test suite. Server-dependent tests get a real gateway +
# world server started for them and torn down afterward; the pure unit
# tests (world-manager, client-network-manager.unit) need nothing.
#
# Usage: bash tests/run-all.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
run() {
  echo "--- $1 ---"
  node "$1"
  if [ $? -ne 0 ]; then
    FAIL=1
    echo "✗ $1 FAILED"
  else
    echo "✓ $1 passed"
  fi
  echo
}

echo "=== Pure unit tests (no server needed) ==="
run tests/world-manager.unit.test.js
run tests/client-network-manager.unit.test.js

echo "=== Starting gateway + one world server for integration tests ==="
node gateway/gateway.js > /tmp/test-gateway.log 2>&1 &
GW_PID=$!
SERVER_ID=FRA-01 PORT=8080 GATEWAY_URL=http://localhost:9000 node world/WorldServer.js > /tmp/test-world.log 2>&1 &
WORLD_PID=$!
sleep 1.5

run tests/gateway-world.smoke.test.js
run tests/rejoin.smoke.test.js
run tests/client-network-manager.integration.test.js

echo "=== Stopping test servers ==="
kill "$GW_PID" "$WORLD_PID" 2>/dev/null

if [ "$FAIL" -eq 0 ]; then
  echo "ALL TESTS PASSED"
else
  echo "SOME TESTS FAILED -- see logs above, and /tmp/test-gateway.log / /tmp/test-world.log"
fi
exit $FAIL
