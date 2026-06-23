/**
 * shared/staticServer.js
 * -----------------------------------------------------------------------
 * Minimal static file serving, just enough to serve index.html so the
 * project runs from `node gateway/gateway.js` (or a world server, for
 * local single-process testing) with no separate static-file tooling.
 *
 * Both the gateway and any world server can serve the same index.html --
 * in a real deployment only the gateway needs to (per the architecture:
 * CLIENT -> Gateway -> World Server), but world servers serve it too so
 * `node world/WorldServer.js` remains independently runnable for local
 * development, exactly like the original single-server foundation was.
 * -----------------------------------------------------------------------
 */

const fs = require('fs');

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} indexHtmlPath - absolute path to index.html
 * @returns {boolean} true if this helper handled the request (caller should stop)
 */
function serveIndexIfRoot(req, res, indexHtmlPath) {
  if (req.method !== 'GET') return false;
  if (req.url !== '/' && req.url !== '/index.html') return false;

  fs.readFile(indexHtmlPath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load index.html');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
  return true;
}

module.exports = { serveIndexIfRoot };
