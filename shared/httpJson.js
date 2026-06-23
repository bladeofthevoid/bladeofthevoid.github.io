/**
 * shared/httpJson.js
 * -----------------------------------------------------------------------
 * The gateway and every world server need to talk to each other over
 * plain HTTP (registration, heartbeats, admin "create a world" calls).
 * This is intentionally tiny and dependency-free (built on Node's `http`
 * module only) rather than pulling in axios/node-fetch -- the only thing
 * either side needs is "POST this JSON, get back that JSON".
 *
 * Used by:
 *   - world/WorldServer.js  -> registers + heartbeats with the gateway
 *   - gateway/AssignmentService.js -> asks a world server to create a world
 *   - gateway/gateway.js and world/WorldServer.js -> parse incoming JSON bodies
 * -----------------------------------------------------------------------
 */

const http = require('http');
const https = require('https');

/**
 * POSTs a JSON body to a URL and resolves with the parsed JSON response.
 * Rejects on network error, non-2xx status, or unparsable response body
 * -- callers are expected to treat rejection as "that server is
 * unreachable right now" (see gateway/WorldRegistry.js eviction logic),
 * not as a fatal error.
 *
 * Picks the `http` or `https` module based on the URL's scheme, and -- if
 * the URL has no explicit port -- uses the correct standard default (80
 * for http, 443 for https) rather than Node's own default of 80
 * regardless of scheme. This matters as soon as any of these servers run
 * behind a TLS-terminating host (Render, and most PaaS providers, give
 * you an `https://service.example.com` URL with no port at all): without
 * this, gateway<->world-server registration/heartbeat/admin calls would
 * silently try plain HTTP on port 80 against an HTTPS-only host and fail.
 */
function postJson(url, body, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const payload = JSON.stringify(body || {});
    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port ? Number(target.port) : defaultPort,
        path: target.pathname + (target.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} from ${url}: ${raw}`));
            return;
          }
          if (!raw) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Timed out calling ${url}`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Reads and parses a JSON request body for a Node http.IncomingMessage. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // Defensive cap -- this is an internal admin API, not a public
      // upload endpoint, so a body this large is always a bug or abuse.
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Writes a JSON response with the given status code. */
function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

module.exports = { postJson, readJsonBody, sendJson };
