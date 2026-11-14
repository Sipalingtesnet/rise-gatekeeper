'use strict';

/**
 * Proof module for "rise" — Proof Gatekeeper agent, zkVerify Agent Games
 * Season 01.
 *
 * REAL implementation (Playbook §02.5 + §03): local Groth16 proof
 * generation with snarkjs using the downloaded circuit artifacts, then
 * submission to zkVerify via Kurier REST, polling until the job reaches
 * Finalized. Only then is a proof treated as confirmed. NOTHING in this
 * module ever fabricates a proof, a verification result, or a transaction
 * hash.
 *
 * Circuit (Playbook §02.5, artifacts in circuits/ — see circuits/README.md):
 *   Groth16 / BN128, compiled with Circom 2.x. Template
 *   GatekeeperEvaluation. vk_hash registered on zkVerify mainnet (from
 *   https://agentgames.zkverify.io/api/circuit-info):
 *     0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
 *   (NOTE: the vk_hash values transcribed from Playbook screenshots in an
 *   earlier note were truncated/mangled by screenshot OCR — the values
 *   served live by /api/circuit-info are authoritative and are the ones
 *   used here.)
 *
 * Circuit inputs — DISCOVERED EMPIRICALLY (2026-11-14), not published on
 * the Playbook page: the 13 input signal names were found by probing the
 * downloaded wasm with circom_runtime's WitnessCalculator (a name that
 * exists is accepted, any other name errors), and the encodings were
 * confirmed by generating proofs and verifying them locally against the
 * exported verification key. The mapping lives in ONE function,
 * buildCircuitInputs(), below. Public signals (13, in order):
 *   [ Poseidon(salt, taskId), registeredVkHash, proofVkHash, minimum,
 *     publicBalance, expiryBlock, currentBlock, recipient,
 *     conditionRecipient, amount, maxTransfer, decision, taskId ]
 *   Public signal 0 — Poseidon(salt, taskId) — is the proof reference
 *   (nullifier) binding the proof to its task; it was identified by
 *   varying one input at a time and matching the value against Poseidon
 *   candidates. The circuit enforces decision correctness: a decision
 *   inconsistent with the checks fails witness generation with an assert
 *   (template GatekeeperEvaluation line ~102) — the circuit is the
 *   referee, so generateProof is only ever called with the decision that
 *   decide.js already computed.
 *
 * Encodings (documented assumptions — the Playbook does not publish them;
 * they are the standard conventions and they produce proofs that verify
 * locally against the registered vk):
 *   - addresses (recipient, conditionRecipient): BigInt(hex), 160-bit fits.
 *   - integers (amount, maxTransfer, minimum, publicBalance, expiryBlock,
 *     currentBlock): BigInt as-is.
 *   - decision: 1n for APPROVE, 0n for REJECT.
 *   - taskId: keccak256(utf8(taskId)) mod FIELD_PRIME.
 *   - registeredVkHash / proofVkHash: BigInt(0x-hash) mod FIELD_PRIME
 *     (a 256-bit hash exceeds the BN128 field modulus, so reduce mod p).
 *   - salt: keccak256('agent-games-salt|' + taskId) mod FIELD_PRIME —
 *     deterministic per taskId (unique per task, reproducible). The
 *     platform only ever sees Poseidon(salt, taskId) as public signal 0,
 *     never the salt itself.
 *
 * Kurier (Playbook §03, RECOMMENDED path; zkVerifyJS is NOT implemented):
 *   POST {API_URL}/submit-proof/{KURIER_API_KEY}
 *   body: { proofType: 'groth16', vkRegistered: true,
 *           proofOptions: { library: 'snarkjs', curve: 'bn128' },
 *           proofData: { proof, publicSignals, vk: GATEKEEPER_VK_HASH } }
 *   GET  {API_URL}/job-status/{KURIER_API_KEY}/{jobId}
 *   states: Submitted → IncludedInBlock → Finalized. Only Finalized
 *   counts as confirmed. API key comes from env KURIER_API_KEY only
 *   (create one at https://kurier.xyz for mainnet) — never hardcoded,
 *   never committed, never logged.
 *
 * Timeouts: proof generation + submission + polling run inside a
 * PROOF_BUDGET_MS budget (40s), well inside the Playbook's 60s hard
 * deadline; the server additionally caps the whole proof attempt at 45s.
 * A proof failure or timeout NEVER changes the decision — the response
 * simply omits the proof fields.
 */

const fs = require('node:fs');
const path = require('node:path');

const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const GATEKEEPER_VK_HASH =
  '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const KURIER_API_URL_DEFAULT = 'https://api.kurier.xyz/api/v1';
const PROOF_BUDGET_MS = 40000;
const DEFAULT_WASM_PATH = path.join(__dirname, 'circuits', 'gatekeeper.wasm');
const DEFAULT_ZKEY_PATH = path.join(__dirname, 'circuits', 'gatekeeper_final.zkey');

function env(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function wasmPath() {
  return env('ZK_WASM_PATH') || DEFAULT_WASM_PATH;
}

function zkeyPath() {
  return env('ZK_ZKEY_PATH') || DEFAULT_ZKEY_PATH;
}

function kurierApiUrl() {
  return (env('KURIER_API_URL') || KURIER_API_URL_DEFAULT).replace(/\/$/, '');
}

/** True only when every piece needed for a real proof is configured. */
function getProofStatus() {
  const wp = wasmPath();
  const zp = zkeyPath();
  const hasArtifacts = fs.existsSync(wp) && fs.existsSync(zp);
  let snarkjsAvailable = false;
  try {
    require.resolve('snarkjs');
    snarkjsAvailable = true;
  } catch {
    snarkjsAvailable = false;
  }
  const kurierConfigured = !!env('KURIER_API_KEY');
  const configured = hasArtifacts && snarkjsAvailable && kurierConfigured;
  return {
    configured,
    enabled: process.env.PROOF_ENABLED === '1',
    hasArtifacts,
    snarkjsAvailable,
    kurierConfigured,
    wasmPath: wp,
    zkeyPath: zp,
    vkHash: GATEKEEPER_VK_HASH,
    kurierApiUrl: kurierApiUrl(),
  };
}

function notConfigured(reason) {
  return { ok: false, configured: false, reason };
}

/** 0x-hex string → field element (reduce mod p; a 256-bit hash exceeds p). */
function fieldFromHex(hex, label) {
  const s = String(hex).trim();
  if (!/^0x[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`${label} is not a 0x-hex value: ${String(hex).slice(0, 40)}`);
  }
  return BigInt(s) % FIELD_PRIME;
}

/** UTF-8 string → field element via keccak256, reduced mod p. */
function fieldFromString(str) {
  const { keccak256 } = require('js-sha3');
  return BigInt(`0x${keccak256(String(str))}`) % FIELD_PRIME;
}

/**
 * Per-task salt. Deterministic from the taskId so a proof is reproducible
 * and unique per task; the platform only ever sees Poseidon(salt, taskId)
 * (public signal 0), never the salt itself.
 */
function deriveSalt(taskId) {
  return fieldFromString(`agent-games-salt|${taskId}`);
}

/**
 * THE circuit-input mapping (see the header comment for how it was
 * discovered and verified). Takes the decided task fields — taskId,
 * registeredVk/proofVk (0x-hex), recipient/conditionRecipient (0x-hex),
 * amount/maxTransfer/minimum/publicBalance/expiryBlock/currentBlock
 * (integers or integer strings), decision ('APPROVE' | 'REJECT') — and
 * returns the 13 circuit inputs keyed by their exact signal names.
 * Throws on missing or malformed inputs (callers treat that as "no proof").
 */
function buildCircuitInputs(d) {
  const taskId = d.taskId ?? d.task_id;
  if (taskId === undefined || taskId === null || taskId === '') {
    throw new Error('missing taskId');
  }
  if (d.registeredVk === undefined && d.registered_vk === undefined) {
    throw new Error('missing registeredVk');
  }
  if (d.proofVk === undefined && d.proof_vk === undefined) {
    throw new Error('missing proofVk');
  }
  const num = (v, label) => {
    if (v === undefined || v === null || v === '') throw new Error(`missing ${label}`);
    return BigInt(v);
  };
  return {
    recipient: fieldFromHex(d.recipient, 'recipient'),
    conditionRecipient: fieldFromHex(
      d.conditionRecipient ?? d.condition_recipient,
      'conditionRecipient',
    ),
    amount: num(d.amount, 'amount'),
    maxTransfer: num(d.maxTransfer ?? d.max_transfer, 'maxTransfer'),
    minimum: num(d.minimum, 'minimum'),
    publicBalance: num(d.publicBalance ?? d.public_balance, 'publicBalance'),
    expiryBlock: num(d.expiryBlock ?? d.expiry_block, 'expiryBlock'),
    currentBlock: num(d.currentBlock ?? d.current_block, 'currentBlock'),
    decision: d.decision === 'APPROVE' ? 1n : 0n,
    taskId: fieldFromString(taskId),
    registeredVkHash: fieldFromHex(d.registeredVk ?? d.registered_vk, 'registeredVk'),
    proofVkHash: fieldFromHex(d.proofVk ?? d.proof_vk, 'proofVk'),
    salt: deriveSalt(taskId),
  };
}

/**
 * Generate a Groth16 proof for the decision inputs with snarkjs.
 * Returns { ok: true, proof, publicSignals } on success, or
 * { ok: false, ... } with a reason. Never returns a fabricated proof.
 * A decision inconsistent with the checks fails witness generation
 * (the circuit asserts decision correctness) — that is a proof failure,
 * not a proof; the decision itself is unaffected.
 */
async function generateProof(inputs) {
  const status = getProofStatus();
  if (!status.hasArtifacts) {
    return notConfigured(
      'proof not configured: circuit artifacts not found (ZK_WASM_PATH / ZK_ZKEY_PATH)',
    );
  }
  if (!status.snarkjsAvailable) {
    return notConfigured('proof not configured: snarkjs is not installed');
  }
  let circuitInputs;
  try {
    circuitInputs = buildCircuitInputs(inputs);
  } catch (e) {
    return { ok: false, configured: true, reason: `cannot build circuit inputs: ${e.message}` };
  }
  let snarkjs;
  try {
    snarkjs = require('snarkjs');
  } catch {
    return notConfigured('proof not configured: snarkjs is not installed');
  }
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      wasmPath(),
      zkeyPath(),
    );
    return { ok: true, configured: true, proof, publicSignals };
  } catch (e) {
    const msg = e && e.message ? String(e.message).split('\n')[0] : String(e);
    return { ok: false, configured: true, reason: `proof generation failed: ${msg}` };
  }
}

/**
 * Submit a proof to zkVerify via Kurier and poll until Finalized.
 * Kurier REST (Playbook §03): POST /submit-proof/{apiKey}, then
 * GET /job-status/{apiKey}/{jobId}. Returns
 * { ok: true, status: 'Finalized', jobId, receipt } only once Finalized
 * is observed, or { ok: false, ... } with a reason. `opts.fetchImpl`
 * lets tests stub the network (no live key, no real call in tests).
 * Never claims finalization it did not observe.
 */
async function submitProof(proof, publicSignals, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const apiKey = env('KURIER_API_KEY');
  if (!apiKey) {
    return notConfigured(
      'proof submission not configured: KURIER_API_KEY missing (create one at https://kurier.xyz)',
    );
  }
  const apiUrl = kurierApiUrl();
  let submitRes;
  try {
    submitRes = await fetchImpl(`${apiUrl}/submit-proof/${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proofType: 'groth16',
        vkRegistered: true,
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        proofData: { proof, publicSignals, vk: GATEKEEPER_VK_HASH },
      }),
    });
  } catch (e) {
    return { ok: false, configured: true, reason: `kurier submit request failed: ${e.message}` };
  }
  if (!submitRes.ok) {
    return { ok: false, configured: true, reason: `kurier submit failed: HTTP ${submitRes.status}` };
  }
  let submitted;
  try {
    submitted = await submitRes.json();
  } catch {
    return { ok: false, configured: true, reason: 'kurier submit returned invalid JSON' };
  }
  const jobId = submitted.jobId ?? submitted.job_id ?? submitted.id;
  if (!jobId) {
    return { ok: false, configured: true, reason: 'kurier submit returned no job id' };
  }
  const deadline = Date.now() + (opts.budgetMs ?? PROOF_BUDGET_MS);
  const pollMs = opts.pollMs ?? 2000;
  for (;;) {
    let statusRes;
    try {
      statusRes = await fetchImpl(
        `${apiUrl}/job-status/${apiKey}/${encodeURIComponent(jobId)}`,
      );
    } catch (e) {
      return { ok: false, configured: true, reason: `kurier job-status failed: ${e.message}`, jobId };
    }
    if (statusRes.ok) {
      let st;
      try {
        st = await statusRes.json();
      } catch {
        st = null;
      }
      const state = st ? String(st.status ?? st.state ?? '').trim() : '';
      if (state === 'Finalized') {
        return { ok: true, configured: true, status: 'Finalized', jobId, receipt: st };
      }
      if (state === 'Failed' || state === 'Rejected' || state === 'Error') {
        return { ok: false, configured: true, reason: `proof job ${state}`, jobId };
      }
      // 'Submitted' / 'IncludedInBlock' (or anything else unrecognized):
      // keep polling until the budget runs out.
    }
    if (Date.now() > deadline) {
      return { ok: false, configured: true, reason: 'timed out waiting for proof finalization', jobId };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Full flow: generate a proof for a decided task, submit it, wait for
 * finalization. Returns { ok: true, proof, publicSignals, status, jobId }
 * only when a real proof was generated AND its verification finalized;
 * otherwise { ok: false, configured: <bool>, reason }. Callers must
 * treat ok:false as "no proof" — never as a proof. The decision itself
 * is never changed by this function.
 */
async function proveDecision(decisionInputs, opts = {}) {
  const generated = await generateProof(decisionInputs);
  if (!generated.ok) return generated;
  const submitted = await submitProof(generated.proof, generated.publicSignals, opts);
  if (!submitted.ok) return submitted;
  return {
    ok: true,
    configured: true,
    proof: generated.proof,
    publicSignals: generated.publicSignals,
    status: submitted.status,
    jobId: submitted.jobId,
    receipt: submitted.receipt,
  };
}

module.exports = {
  getProofStatus,
  generateProof,
  submitProof,
  proveDecision,
  buildCircuitInputs,
  deriveSalt,
  FIELD_PRIME,
  GATEKEEPER_VK_HASH,
  KURIER_API_URL_DEFAULT,
  PROOF_BUDGET_MS,
};
