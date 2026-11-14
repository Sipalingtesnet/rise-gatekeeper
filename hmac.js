'use strict';

/**
 * HMAC helpers for the Agent Games agent interface (Playbook §02).
 *
 * The platform signs every request it sends with HMAC-SHA256 over the RAW
 * request body, using the per-agent secret the operator copies from the
 * dashboard ("Rotate Secret") into AGENT_GAMES_HMAC_SECRET. The signature
 * travels in the `x-agent-games-signature` header. Responses are signed the
 * same way, over the raw response body, with the same secret and header.
 *
 * Wire format assumption (the Playbook does not spell out the exact
 * encoding): the header carries the lowercase hex HMAC-SHA256 of the raw
 * body bytes. A `sha256=<hex>` prefixed value (the GitHub-style form) is
 * also accepted on verify. See README "Assumptions".
 */

const crypto = require('node:crypto');

const HEADER = 'x-agent-games-signature';

/** HMAC-SHA256 of `raw` (Buffer or string) with `secret`; lowercase hex. */
function sign(secret, raw) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Verify a received `x-agent-games-signature` header value against the raw
 * body. Constant-time comparison; false on any mismatch, missing header,
 * missing/empty secret, or malformed value. Never throws.
 */
function verify(secret, raw, headerValue) {
  try {
    if (!secret || typeof secret !== 'string' || secret.length === 0) return false;
    if (!headerValue || typeof headerValue !== 'string') return false;
    let presented = headerValue.trim().toLowerCase();
    if (presented.startsWith('sha256=')) presented = presented.slice('sha256='.length);
    if (!/^[0-9a-f]{64}$/.test(presented)) return false;
    const expected = sign(secret, raw);
    const a = Buffer.from(presented, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { sign, verify, HEADER };
