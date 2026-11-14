'use strict';

/**
 * rise — Proof Gatekeeper agent, zkVerify Agent Games Season 01.
 *
 * Zero-dependency Node.js service (built-in `http` / `crypto` only).
 *
 *   GET  /health   → {"status":"ok","agent":"rise"}   (arena health check, unsigned)
 *   POST /agent    → task envelope or preflight (HMAC-signed, see below)
 *
 * Every POST is authenticated: the platform signs the RAW request body with
 * HMAC-SHA256 (header `x-agent-games-signature`, secret from env
 * AGENT_GAMES_HMAC_SECRET — the plaintext the operator copies from the
 * dashboard's "Rotate Secret"). The signature is verified against the raw
 * body BEFORE any parsing. A bad or missing signature gets HTTP 401 and no
 * decision. If no secret is configured at all, every POST is refused
 * (fail closed — the server cannot authenticate anything).
 *
 * Every POST response is signed the same way (HMAC over the raw response
 * body, same header, same secret).
 *
 * Message types (Playbook §02), dispatched on `type`:
 *   agent-games.proof-gatekeeper.v1 → task; response
 *       {"decision":"APPROVE"|"REJECT","reason_code":"...","proof_tx":"...?"}
 *       plus "proof" / "public_signals" only when a real proof exists
 *       (see proof.js — scaffolded, not live yet).
 *   agent-games.preflight.v1 → preflight; response
 *       {"ok":true,"protocolVersion":"v1"} (signed).
 *   (no `type`) → treated as a task (flat test-only form, for local testing).
 *   anything else → HTTP 400.
 *
 * Decision rules live in decide.js. The 60s hard deadline from the
 * Playbook is enforced two ways: tasks past `deadline_at` are rejected in
 * decide.js, and the HTTP server closes requests still open after 60s.
 *
 * Run with `node server.js` (PORT env var, default 3000). Secrets come
 * from the environment only — never hardcoded, never committed, never
 * logged.
 */

const http = require('node:http');
const { decide } = require('./decide');
const { sign, verify, HEADER } = require('./hmac');
const proof = require('./proof');

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const PROOF_TIMEOUT_MS = 10000; // never let proof generation eat the task window

const TASK_TYPE = 'agent-games.proof-gatekeeper.v1';
const PREFLIGHT_TYPE = 'agent-games.preflight.v1';

function getSecret() {
  return process.env.AGENT_GAMES_HMAC_SECRET || '';
}

/** Send JSON; sign the body when a secret is configured. */
function sendJson(res, status, obj, secret) {
  const body = JSON.stringify(obj);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  };
  if (secret) headers[HEADER] = sign(secret, body);
  res.writeHead(status, headers);
  res.end(body);
}

/** Normalize proof inputs from an envelope (nested or flat test form). */
function proofInputsFor(envelope, decision) {
  const input =
    envelope.input && typeof envelope.input === 'object' && !Array.isArray(envelope.input)
      ? envelope.input
      : envelope;
  return {
    registeredVk: input.registered_vk ?? input.expectedVk ?? input.expected_vk,
    proofVk: input.proof_vk ?? input.proofVk ?? input.vk,
    recipient: input.recipient,
    conditionRecipient: input.condition_recipient ?? input.expectedRecipient,
    amount: input.amount,
    maxTransfer: input.max_transfer ?? input.maximum ?? input.threshold,
    decision,
  };
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', agent: 'rise' });
  }

  if (req.method === 'POST' && url.pathname === '/agent') {
    const secret = getSecret();
    if (!secret) {
      // Fail closed: without a secret the server cannot authenticate
      // anything, so no decision is ever returned.
      return sendJson(res, 401, { error: 'hmac secret not configured' });
    }
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
    req.on('end', async () => {
      if (tooBig) return;
      const rawBody = Buffer.concat(chunks);
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

      // Proof (Playbook scaffold points 4–5): only attempted when the
      // operator enabled it AND the artifacts/credentials are configured.
      // A failure or timeout simply omits the proof fields — the decision
      // itself is always returned. Never blocks past the proof timeout.
      if (process.env.PROOF_ENABLED === '1') {
        try {
          const proved = await Promise.race([
            proof.proveDecision(proofInputsFor(msg, result.decision)),
            new Promise((resolve) =>
              setTimeout(() => resolve({ ok: false, reason: 'proof timeout' }), PROOF_TIMEOUT_MS),
            ),
          ]);
          if (proved && proved.ok) {
            out.proof = proved.proof;
            out.public_signals = proved.publicSignals;
          }
        } catch {
          // Proof errors never change the decision; fields stay omitted.
        }
      }

      return sendJson(res, 200, out, secret);
    });
    req.on('error', () => sendJson(res, 400, { error: 'bad request' }, secret));
    return;
  }

  return sendJson(res, 404, { error: 'not found' });
});

// 60s hard deadline (Playbook): close requests still open after 60s.
server.requestTimeout = 60000;

server.listen(PORT, '0.0.0.0', () => {
  const secret = getSecret();
  if (!secret) {
    console.log(
      'WARNING: AGENT_GAMES_HMAC_SECRET is not set — all POST /agent requests will be refused until it is configured.',
    );
  }
  const proofStatus = proof.getProofStatus();
  console.log(
    `rise gatekeeper listening on :${PORT} (POST /agent, GET /health) — ` +
      `proof ${proofStatus.configured ? 'configured' : 'not configured (scaffolded only)'}`,
  );
});
