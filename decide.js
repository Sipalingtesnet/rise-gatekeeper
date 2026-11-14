'use strict';

/**
 * Decision logic for "rise" — Proof Gatekeeper agent, zkVerify Agent Games
 * Season 01.
 *
 * Decision boundary (from the arena preview): APPROVE only when every field
 * of the incoming task agrees with the committed values. Any mismatch is a
 * REJECT, and incomplete data fails closed (never approve on missing
 * reference values).
 *
 * Reason codes (same vocabulary as the arena's recent-decisions list):
 *   VALID_CONDITION     — everything agrees
 *   VK_SUBSTITUTION     — proof verification key differs from expected
 *   RECIPIENT_MISMATCH  — recipient differs from expected
 *   THRESHOLD_MISMATCH  — amount is negative, missing, or above the maximum
 */

const REASONS = {
  VALID: 'VALID_CONDITION',
  VK: 'VK_SUBSTITUTION',
  RECIPIENT: 'RECIPIENT_MISMATCH',
  THRESHOLD: 'THRESHOLD_MISMATCH',
};

function pick(obj, names) {
  for (const name of names) {
    const v = obj[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normAddr(v) {
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

/**
 * Decide on one incoming task.
 *
 * Accepted task shape (assumed from the arena preview — see README.md):
 *   {
 *     id?: string,                    // echoed back as taskId if present
 *     recipient: string,              // payment recipient (address)
 *     expectedRecipient: string,      // committed recipient
 *     amount: number|string,          // amount to verify (aliases: publicBalance, value)
 *     maximum: number|string,         // committed cap (aliases: threshold, max, limit)
 *     proofVk: string,                // submitted proof verification key (alias: vk)
 *     expectedVk: string,             // committed VK (aliases: expectedProofVk, committedVk)
 *     ...any other fields are tolerated and ignored
 *   }
 */
function decide(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { decision: 'REJECT', reason: REASONS.VK };
  }

  const proofVk = pick(task, ['proofVk', 'vk', 'proof_vk']);
  const expectedVk = pick(task, ['expectedVk', 'expectedProofVk', 'committedVk', 'expected_vk']);
  const recipient = pick(task, ['recipient', 'to', 'payee']);
  const expectedRecipient = pick(task, ['expectedRecipient', 'committedRecipient', 'expected_recipient']);
  const amountRaw = pick(task, ['amount', 'publicBalance', 'value', 'public_balance']);
  const maximumRaw = pick(task, ['maximum', 'threshold', 'max', 'limit']);

  // 1. Proof VK must match exactly. Missing either side fails closed.
  if (
    expectedVk === undefined ||
    proofVk === undefined ||
    String(proofVk).trim() !== String(expectedVk).trim()
  ) {
    return { decision: 'REJECT', reason: REASONS.VK };
  }

  // 2. Recipient must match (case-insensitive, for hex addresses).
  if (
    expectedRecipient === undefined ||
    recipient === undefined ||
    normAddr(recipient) !== normAddr(expectedRecipient)
  ) {
    return { decision: 'REJECT', reason: REASONS.RECIPIENT };
  }

  // 3. Amount must be a non-negative number within the committed maximum.
  // BigInt comparison when both sides are integers (avoids float precision
  // loss on large on-chain values); Number fallback otherwise.
  const amountBig = toBigInt(amountRaw);
  const maximumBig = toBigInt(maximumRaw);
  if (amountBig !== null && maximumBig !== null) {
    if (amountBig < 0n || amountBig > maximumBig) {
      return { decision: 'REJECT', reason: REASONS.THRESHOLD };
    }
  } else {
    const amount = toNumber(amountRaw);
    const maximum = toNumber(maximumRaw);
    if (!Number.isFinite(amount) || !Number.isFinite(maximum) || amount < 0 || amount > maximum) {
      return { decision: 'REJECT', reason: REASONS.THRESHOLD };
    }
  }

  return { decision: 'APPROVE', reason: REASONS.VALID };
}

module.exports = { decide, REASONS };
