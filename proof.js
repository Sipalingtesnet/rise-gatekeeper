'use strict';

/**
 * Proof module for "rise" — Proof Gatekeeper agent, zkVerify Agent Games
 * Season 01.
 *
 * Playbook scaffold (points 4–5):
 *   4. Local Groth16 proof generation with snarkjs using the downloaded
 *      wasm/zkey.
 *   5. zkVerify submission (Kurier REST or zkVerifyJS) — wait for a
 *      finalized result before treating a proof as confirmed.
 *
 * STATUS: SCAFFOLDED, NOT LIVE. The wasm/zkey circuit artifacts come from
 * the Playbook downloads, which are not in this repo, and no Kurier /
 * zkVerifyJS credential is configured here. This module therefore structures
 * the real flow — generate → submit → wait for finalization — but returns a
 * clear "not configured" result instead of inventing a proof. NOTHING in
 * this module ever fabricates a proof, a verification result, or a
 * transaction hash. The decision path (decide.js + server.js) works fully
 * without a proof and omits the `proof` / `public_signals` response fields
 * until a real proof exists.
 *
 * To go live, the operator must:
 *   1. Download the Playbook's wasm/zkey for the gatekeeper circuit and
 *      point ZK_WASM_PATH / ZK_ZKEY_PATH at them.
 *   2. Install snarkjs (`npm install snarkjs`) — it is an optional
 *      dependency, loaded lazily only when configured.
 *   3. Set either ZK_KURIER_URL + ZK_KURIER_API_KEY (Kurier REST) or
 *      ZK_SEED_PHRASE (zkVerifyJS path; see README — never commit it).
 *   4. Set PROOF_ENABLED=1 so the server attempts proof generation.
 */

const fs = require('node:fs');

function env(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/** True only when every piece needed for a real proof is configured. */
function getProofStatus() {
  const wasmPath = env('ZK_WASM_PATH');
  const zkeyPath = env('ZK_ZKEY_PATH');
  const hasArtifacts =
    !!wasmPath && !!zkeyPath && fs.existsSync(wasmPath) && fs.existsSync(zkeyPath);
  let snarkjsAvailable = false;
  try {
    require.resolve('snarkjs');
    snarkjsAvailable = true;
  } catch {
    snarkjsAvailable = false;
  }
  const kurierConfigured = !!env('ZK_KURIER_URL') && !!env('ZK_KURIER_API_KEY');
  const zkVerifyJsConfigured = !!env('ZK_SEED_PHRASE');
  const configured = hasArtifacts && snarkjsAvailable && (kurierConfigured || zkVerifyJsConfigured);
  return {
    configured,
    enabled: process.env.PROOF_ENABLED === '1',
    hasArtifacts,
    snarkjsAvailable,
    kurierConfigured,
    zkVerifyJsConfigured,
    wasmPath: wasmPath || null,
    zkeyPath: zkeyPath || null,
  };
}

function notConfigured(reason) {
  return { ok: false, configured: false, reason };
}

/**
 * Generate a Groth16 proof for the decision inputs with snarkjs.
 * Returns { ok: true, proof, publicSignals } on success, or
 * { ok: false, configured: false, reason } when the artifacts / snarkjs
 * are not configured. Never returns a fabricated proof.
 */
async function generateProof(inputs) {
  const status = getProofStatus();
  if (!status.hasArtifacts) {
    return notConfigured(
      'proof not configured: ZK_WASM_PATH / ZK_ZKEY_PATH missing or files not found',
    );
  }
  if (!status.snarkjsAvailable) {
    return notConfigured('proof not configured: snarkjs is not installed');
  }
  // Real path — only reachable once the operator has the Playbook artifacts
  // and snarkjs installed. The circuit inputs below are the decision
  // boundary values; the exact input mapping is defined by the circuit the
  // Playbook ships, so it is assembled here from the decided fields.
  const snarkjs = require('snarkjs');
  const circuitInputs = {
    registeredVk: inputs.registeredVk,
    proofVk: inputs.proofVk,
    recipient: inputs.recipient,
    conditionRecipient: inputs.conditionRecipient,
    amount: inputs.amount,
    maxTransfer: inputs.maxTransfer,
    decision: inputs.decision === 'APPROVE' ? 1 : 0,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    process.env.ZK_WASM_PATH,
    process.env.ZK_ZKEY_PATH,
  );
  return { ok: true, configured: true, proof, publicSignals };
}

/**
 * Submit a proof to zkVerify and wait for a finalized result.
 * Kurier REST path (ZK_KURIER_URL + ZK_KURIER_API_KEY). Returns
 * { ok: true, status: 'finalized', receipt } on finalization, or
 * { ok: false, ... } with a reason. Never claims finalization it did not
 * observe. The zkVerifyJS path is not implemented here — it needs a funded
 * account and a seed phrase; see README.
 */
async function submitProof(proof, publicSignals) {
  const url = env('ZK_KURIER_URL');
  const apiKey = env('ZK_KURIER_API_KEY');
  if (!url || !apiKey) {
    return notConfigured('proof submission not configured: ZK_KURIER_URL / ZK_KURIER_API_KEY missing');
  }
  const submitRes = await fetch(`${url.replace(/\/$/, '')}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ proof, publicSignals }),
  });
  if (!submitRes.ok) {
    return { ok: false, configured: true, reason: `kurier submit failed: HTTP ${submitRes.status}` };
  }
  const submitted = await submitRes.json();
  const jobId = submitted.jobId ?? submitted.id;
  if (!jobId) {
    return { ok: false, configured: true, reason: 'kurier submit returned no job id' };
  }
  // Poll for finalization. The exact status endpoint/shape is defined by
  // the Kurier API the operator uses; poll until a finalized status is
  // observed or the deadline passes.
  const deadline = Date.now() + 120000;
  for (;;) {
    const statusRes = await fetch(`${url.replace(/\/$/, '')}/status/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (statusRes.ok) {
      const status = await statusRes.json();
      const state = String(status.status ?? status.state ?? '').toLowerCase();
      if (state === 'finalized' || state === 'verified' || state === 'confirmed') {
        return { ok: true, configured: true, status: 'finalized', receipt: status };
      }
      if (state === 'failed' || state === 'rejected' || state === 'error') {
        return { ok: false, configured: true, reason: `proof job ${state}` };
      }
    }
    if (Date.now() > deadline) {
      return { ok: false, configured: true, reason: 'timed out waiting for proof finalization' };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Full flow: generate a proof for a decided task, submit it, wait for
 * finalization. Returns { ok: true, proof, publicSignals, status } only
 * when a real proof was generated AND its verification finalized; otherwise
 * { ok: false, configured: <bool>, reason }. Callers must treat ok:false
 * as "no proof" — never as a proof.
 */
async function proveDecision(decisionInputs) {
  const generated = await generateProof(decisionInputs);
  if (!generated.ok) return generated;
  const submitted = await submitProof(generated.proof, generated.publicSignals);
  if (!submitted.ok) return submitted;
  return {
    ok: true,
    configured: true,
    proof: generated.proof,
    publicSignals: generated.publicSignals,
    status: submitted.status,
    receipt: submitted.receipt,
  };
}

module.exports = { getProofStatus, generateProof, submitProof, proveDecision };
