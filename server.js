'use strict';

/**
 * rise — Proof Gatekeeper agent, zkVerify Agent Games Season 01.
 *
 * Zero-dependency Node.js service (built-in `http` only).
 *
 *   GET  /health   → {"status":"ok","agent":"rise"}   (arena health check)
 *   POST /agent    → {"decision":"APPROVE"|"REJECT","reason":"...","agent":"rise","taskId":"...?"}
 *
 * Decision rules live in decide.js. Run with `node server.js`
 * (PORT env var, default 3000).
 */

const http = require('node:http');
const { decide } = require('./decide');

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', agent: 'rise' });
  }

  if (req.method === 'POST' && url.pathname === '/agent') {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
      let task;
      try {
        task = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        return sendJson(res, 400, { error: 'task must be a JSON object' });
      }
      const result = decide(task);
      const out = { decision: result.decision, reason: result.reason, agent: 'rise' };
      const taskId = task.id ?? task.taskId ?? task.task_id;
      if (taskId !== undefined) out.taskId = String(taskId);
      return sendJson(res, 200, out);
    });
    req.on('error', () => sendJson(res, 400, { error: 'bad request' }));
    return;
  }

  return sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`rise gatekeeper listening on :${PORT} (POST /agent, GET /health)`);
});
