# Tests

Lightweight verification scripts, not a formal test framework dependency
(no jest/mocha) -- each file is a self-contained Node script that exits 0
on success and 1 on failure, so they're trivial to run individually or
wire into CI later.

Run everything: `bash tests/run-all.sh`

| File | What it verifies | Needs a running server? |
|---|---|---|
| `world-manager.unit.test.js` | Dynamic world creation, "type full → create type-002" auto-assignment, destruction, `MAX_WORLDS` enforcement | No |
| `client-network-manager.unit.test.js` | The CLIENT's `NetworkManager` (extracted live from `index.html`) correctly drives the gateway→world handoff against a mock WebSocket; confirms the gateway's own intentional close is never mistaken for a dropped connection | No |
| `gateway-world.smoke.test.js` | Raw end-to-end protocol check: gateway redirect → world connect → welcome/snapshot/pong, against the real server stack | Yes (gateway + 1 world server) |
| `rejoin.smoke.test.js` | Disconnect mid-session, reconnect with the rejoin token within the grace period, confirm the *same* entity (position preserved) is restored under a new connection id | Yes (1 world server) |
| `client-network-manager.integration.test.js` | Same extracted client `NetworkManager` as the unit test, but driven against the real gateway + world server over real WebSockets | Yes (gateway + 1 world server) |

`_extractClientModules.js` is a shared helper, not a test itself -- it
pulls `MessageTypes`/`NetworkManager`/`buildWsUrl` directly out of
`index.html`'s source so the client-side tests always exercise the exact
code that ships, rather than a hand-copied duplicate that could quietly
drift out of sync.
