'use strict';

/**
 * Vercel serverless adapter — GET /api/health.
 *
 * Unsigned liveness check for the arena. Mirrors GET /health in
 * server.js: {"status":"ok","agent":"rise"}.
 */

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', agent: 'rise' }));
};
