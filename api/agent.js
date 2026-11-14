'use strict';

/**
 * Vercel serverless adapter for the rise gatekeeper — POST /agent.
 *
 * Same interface as server.js (the always-on Node service), repackaged as
 * a Vercel Hobby serverless function so the endpoint costs $0 and needs no
 * credit card: the decision logic lives in ../decide.js, the HMAC helpers
 * in ../hmac.js. This file only adapts the transport (raw-body read,
 * dispatch, signed responses).
 *
 * Behaviour mirrors server.js exactly:
 *   - HMAC-SHA256 over the RAW request body (header
 *     `x-agent-games-signature`, secret from env AGENT_GAMES_HMAC_SECRET)
 *     is verified BEFORE any parsing; bad/missing signature → 401.
 *   - No secret configured → every POST refused (fail closed).
 *   - `agent-games.preflight.v1` → signed {ok:true, protocolVersion:"v1"}.
 *   - `agent-games.proof-gatekeeper.v1` (or no `type`) → decide() →
 *     {decision, reason_code, proof_tx?}; unknown `type` → 400.
 *   - Every response is signed the same way (when a secret exists).
 *
 * Differences from server.js (deliberate):
 *   - No proof generation is attempted here. The Vercel Hobby function
 *     limit is 10s and snarkjs/wasm proof generation does not fit that
 *     budget; PROOF_ENABLED is ignored. The decision is always returned
 *     (the `proof` / `public_signals` fields stay omitted until a real
 *     proof exists — same as the scaffolded server.js without artifacts).
 *   - Body parsing is disabled (`bodyParser: false`) so the raw bytes
 *     needed for HMAC verification survive untouched.
 *
 * Deploy: `vercel deploy` (or link the GitHub repo in the Vercel
 * dashboard), then set the env var AGENT_GAMES_HMAC_SECRET (the dashboard
 * "Rotate Secret" value) and register the endpoint URL
 * `https://<app>.vercel.app/api/agent` in the Agent Games dashboard.
 * Health check lives at GET /api/health (see api/health.js).
 */

const { decide } = require('../decide');
const { sign, verify, HEADER } = require('../hmac');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const TASK_TYPE = 'agent-games.proof-gatekeeper.v1';
const PREFLIGHT_TYPE = 'agent-games.preflight.v1';

function getSecret() {
  return process.env.AGENT_GAMES_HMAC_SECRET || '';
}

/** Send JSON; sign the body when a secret is configured. */
function sendJson(res, status, obj, secret) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  if (secret) headers[HEADER] = sign(secret, body);
  res.writeHead(status, headers);
  res.end(body);
}

/** Read the raw request body as a Buffer; null when over the size cap. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
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
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Echo proof_tx from the envelope when present (nested or flat form). */
function proofTxOf(envelope) {
  const input =
    envelope.input && typeof envelope.input === 'object' && !Array.isArray(envelope.input)
      ? envelope.input
      : envelope;
  const tx = input.proof_tx ?? envelope.proof_tx;
  return tx === undefined || tx === null || tx === '' ? undefined : String(tx);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' }, getSecret());
  }

  const secret = getSecret();
  if (!secret) {
    // Fail closed: without a secret the function cannot authenticate
    // anything, so no decision is ever returned.
    return sendJson(res, 401, { error: 'hmac secret not configured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return sendJson(res, 400, { error: 'bad request' }, secret);
  }
  if (rawBody === null) {
    return sendJson(res, 413, { error: 'body too large' }, secret);
  }

  // Verify the HMAC against the RAW body before parsing anything.
  if (!verify(secret, rawBody, req.headers[HEADER])) {
    return sendJson(res, 401, { error: 'invalid signature' }, secret);
  }

  let msg;
  try {
    msg = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' }, secret);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return sendJson(res, 400, { error: 'message must be a JSON object' }, secret);
  }

  // Preflight: signed handshake, never treated as a task.
  if (msg.type === PREFLIGHT_TYPE) {
    return sendJson(res, 200, { ok: true, protocolVersion: 'v1' }, secret);
  }
  if (msg.type !== undefined && msg.type !== TASK_TYPE) {
    return sendJson(res, 400, { error: 'unknown message type' }, secret);
  }

  const result = decide(msg);
  const out = { decision: result.decision, reason_code: result.reason_code };
  const tx = proofTxOf(msg);
  if (tx !== undefined) out.proof_tx = tx;

  return sendJson(res, 200, out, secret);
};

// Keep the raw body: Vercel's default JSON body parser would consume it.
module.exports.config = { api: { bodyParser: false } };
