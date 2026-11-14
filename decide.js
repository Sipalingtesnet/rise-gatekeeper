'use strict';

/**
 * Decision logic for "rise" — Proof Gatekeeper agent, zkVerify Agent Games
 * Season 01.
 *
 * Real task schema (Playbook §02 "Agent Interface — Receive, decide,
 * respond"): the arena POSTs an envelope; the decision inputs live under
 * `input`:
 *
 *   {
 *     "type": "agent-games.proof-gatekeeper.v1",
 *     "task_id": "gk_8d31...",
 *     "mode": "competition",
 *     "issued_at": "<issued-at>",
 *     "deadline_at": "<deadline>",
 *     "input": {
 *       "registered_vk": "0x7d...01",
 *       "proof_vk": "0x13...aa",
 *       "minimum": "1000",
 *       "public_balance": "1460",
 *       "expiry_block": 8430000,
 *       "current_block": 8420000,
 *       "recipient": "0xDe62..9F81",
 *       "condition_recipient": "0xDe62..9F81",
 *       "amount": "500",
 *       "max_transfer": "1000",
 *       "proof_tx": "0xa8...2c"
 *     }
 *   }
 *
 * Decision boundary: APPROVE only when EVERY check passes. Any mismatch is
 * a REJECT, and incomplete data fails closed (never approve on missing
 * reference values).
 *
 * Reason codes (the arena's own vocabulary):
 *   VALID_CONDITION     — everything agrees
 *   VK_SUBSTITUTION     — proof_vk differs from registered_vk
 *   RECIPIENT_MISMATCH  — recipient differs from condition_recipient
 *   THRESHOLD_MISMATCH  — amount / balance / expiry / deadline check fails
 *
 * Checks, in order:
 *   1. proof_vk == registered_vk (hex, case-insensitive).
 *   2. recipient == condition_recipient (hex, case-insensitive).
 *   3. Thresholds — all must hold:
 *        amount is a non-negative number and amount <= max_transfer;
 *        public_balance >= minimum;
 *        current_block <= expiry_block.
 *      A failure of any of the three is THRESHOLD_MISMATCH.
 *   4. deadline_at, when present and parseable: the task must not be past
 *      its deadline (the Playbook's 60s hard deadline; a stale task is a
 *      REJECT / THRESHOLD_MISMATCH). An unparseable deadline_at is ignored
 *      — it is metadata, not a decision field (see README assumptions).
 *
 * The nested schema is matched on EXACT field names — no aliases. A flat
 * task object (no `input` key) is accepted ONLY as a test-only fallback for
 * local testing, with the legacy v1 aliases; the real schema is always the
 * primary path and flat tasks never occur in live arena traffic.
 */

const REASONS = {
  VALID: 'VALID_CONDITION',
  VK: 'VK_SUBSTITUTION',
  RECIPIENT: 'RECIPIENT_MISMATCH',
  THRESHOLD: 'THRESHOLD_MISMATCH',
};

function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) {
    const v = obj[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normHex(v) {
  return String(v).trim().toLowerCase();
}

function toBigInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Parse deadline_at: ISO 8601 string, or epoch seconds / milliseconds. */
function parseDeadline(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Epoch seconds (< 1e12) or milliseconds (>= 1e12).
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return n < 1e12 ? n * 1000 : n;
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Run the checks over already-resolved fields. Every check fails closed:
 * a missing or non-numeric reference value is a REJECT, never an approve.
 */
function decideFields(f) {
  // 1. Proof VK must match the registered VK exactly (hex, case-insensitive).
  if (
    f.registeredVk === undefined ||
    f.proofVk === undefined ||
    normHex(f.proofVk) !== normHex(f.registeredVk)
  ) {
    return { decision: 'REJECT', reason_code: REASONS.VK };
  }

  // 2. Recipient must match the condition recipient (case-insensitive).
  if (
    f.conditionRecipient === undefined ||
    f.recipient === undefined ||
    normHex(f.recipient) !== normHex(f.conditionRecipient)
  ) {
    return { decision: 'REJECT', reason_code: REASONS.RECIPIENT };
  }

  // 3a. Amount must be a non-negative number and amount <= max_transfer.
  //      BigInt comparison when both sides are integers (avoids float
  //      precision loss on large on-chain values); Number fallback otherwise.
  const amountBig = toBigInt(f.amountRaw);
  const maxBig = toBigInt(f.maxTransferRaw);
  if (amountBig !== null && maxBig !== null) {
    if (amountBig < 0n || amountBig > maxBig) {
      return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
    }
  } else {
    const amount = toNumber(f.amountRaw);
    const max = toNumber(f.maxTransferRaw);
    if (!Number.isFinite(amount) || !Number.isFinite(max) || amount < 0 || amount > max) {
      return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
    }
  }

  // 3b. Public balance must be at least the minimum.
  const balanceBig = toBigInt(f.publicBalanceRaw);
  const minimumBig = toBigInt(f.minimumRaw);
  if (balanceBig !== null && minimumBig !== null) {
    if (balanceBig < minimumBig) {
      return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
    }
  } else {
    const balance = toNumber(f.publicBalanceRaw);
    const minimum = toNumber(f.minimumRaw);
    if (!Number.isFinite(balance) || !Number.isFinite(minimum) || balance < minimum) {
      return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
    }
  }

  // 3c. Current block must not be past the expiry block.
  const currentBig = toBigInt(f.currentRaw);
  const expiryBig = toBigInt(f.expiryRaw);
  if (currentBig !== null && expiryBig !== null) {
    if (currentBig > expiryBig) {
      return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
    }
  } else {
    const current = toNumber(f.currentRaw);
    const expiry = toNumber(f.expiryRaw);
    if (!Number.isFinite(current) || !Number.isFinite(expiry) || current > expiry) {
      return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
    }
  }

  // 4. Wall-clock deadline (Playbook's 60s hard deadline): a task past its
  //    deadline_at is stale — REJECT, never approve by default.
  const deadlineMs = parseDeadline(f.deadlineAt);
  if (deadlineMs !== null && Date.now() > deadlineMs) {
    return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
  }

  return { decision: 'APPROVE', reason_code: REASONS.VALID };
}

/**
 * Decide on one incoming task envelope (or, test-only, a flat task).
 *
 * Returns { decision: 'APPROVE' | 'REJECT', reason_code: <REASONS.*> }.
 */
function decide(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { decision: 'REJECT', reason_code: REASONS.VK };
  }

  const nested =
    task.input && typeof task.input === 'object' && !Array.isArray(task.input);

  if (nested) {
    // Real schema: exact Playbook field names, no aliases.
    const input = task.input;
    return decideFields({
      proofVk: input.proof_vk,
      registeredVk: input.registered_vk,
      recipient: input.recipient,
      conditionRecipient: input.condition_recipient,
      amountRaw: input.amount,
      maxTransferRaw: input.max_transfer,
      minimumRaw: input.minimum,
      publicBalanceRaw: input.public_balance,
      expiryRaw: input.expiry_block,
      currentRaw: input.current_block,
      deadlineAt: task.deadline_at ?? task.deadlineAt,
    });
  }

  // Flat task — TEST-ONLY fallback for local testing (legacy v1 aliases).
  return decideFields({
    proofVk: pick(task, ['proofVk', 'vk', 'proof_vk']),
    registeredVk: pick(task, ['expectedVk', 'expectedProofVk', 'committedVk', 'expected_vk']),
    recipient: pick(task, ['recipient', 'to', 'payee']),
    conditionRecipient: pick(task, [
      'expectedRecipient',
      'committedRecipient',
      'expected_recipient',
    ]),
    amountRaw: pick(task, ['amount', 'publicBalance', 'value']),
    maxTransferRaw: pick(task, ['maximum', 'threshold', 'max', 'limit']),
    minimumRaw: pick(task, ['minimum']),
    publicBalanceRaw: pick(task, ['public_balance', 'publicBalance']),
    expiryRaw: pick(task, ['expiry_block', 'expiryBlock']),
    currentRaw: pick(task, ['current_block', 'currentBlock']),
    deadlineAt: task.deadline_at ?? task.deadlineAt,
  });
}

module.exports = { decide, REASONS, parseDeadline };
