'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { decide } = require('./decide');
const { sign, verify, HEADER } = require('./hmac');
const proof = require('./proof');

const TEST_SECRET = 'test-secret-do-not-use-in-production';
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';

/** One fully valid task in the REAL nested Playbook schema. */
const validEnvelope = () => ({
  type: 'agent-games.proof-gatekeeper.v1',
  task_id: 'gk_901',
  mode: 'competition',
  issued_at: '2026-11-14T00:00:00Z',
  deadline_at: FUTURE,
  input: {
    registered_vk: '0x7d00000000000000000000000000000000000000000000000000000000000001',
    proof_vk: '0x7d00000000000000000000000000000000000000000000000000000000000001',
    minimum: '1000',
    public_balance: '1460',
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: '0xDe62000000000000000000000000000000009F81',
    condition_recipient: '0xde62000000000000000000000000000000009f81',
    amount: '500',
    max_transfer: '1000',
    proof_tx: '0xa80000000000000000000000000000000000000000000000000000000000002c',
  },
});

// --- pure decision logic: real nested schema --------------------------------

test('decide: fully valid nested task → APPROVE / VALID_CONDITION', () => {
  assert.deepEqual(decide(validEnvelope()), { decision: 'APPROVE', reason_code: 'VALID_CONDITION' });
});

test('decide: amount exactly at max_transfer is still APPROVE (boundary)', () => {
  const t = validEnvelope();
  t.input.amount = '1000';
  assert.deepEqual(decide(t), { decision: 'APPROVE', reason_code: 'VALID_CONDITION' });
});

test('decide: proof_vk differs from registered_vk → REJECT / VK_SUBSTITUTION', () => {
  const t = validEnvelope();
  t.input.proof_vk = '0x13000000000000000000000000000000000000000000000000000000000000aa';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' });
});

test('decide: recipient differs from condition_recipient → REJECT / RECIPIENT_MISMATCH', () => {
  const t = validEnvelope();
  t.input.recipient = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' });
});

test('decide: amount above max_transfer → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validEnvelope();
  t.input.amount = '1460';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: amount as number above max_transfer → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validEnvelope();
  t.input.amount = 1460;
  t.input.max_transfer = 1000;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: public_balance below minimum → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validEnvelope();
  t.input.public_balance = '500';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: current_block past expiry_block → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validEnvelope();
  t.input.current_block = 8430001;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: missing registered_vk fails closed → REJECT / VK_SUBSTITUTION', () => {
  const t = validEnvelope();
  delete t.input.registered_vk;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' });
});

test('decide: missing condition_recipient fails closed → REJECT / RECIPIENT_MISMATCH', () => {
  const t = validEnvelope();
  delete t.input.condition_recipient;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' });
});

test('decide: missing max_transfer fails closed → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validEnvelope();
  delete t.input.max_transfer;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: missing minimum fails closed → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validEnvelope();
  delete t.input.minimum;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: negative amount → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validEnvelope();
  t.input.amount = '-5';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: deadline_at in the past → REJECT / THRESHOLD_MISMATCH (stale task)', () => {
  const t = validEnvelope();
  t.deadline_at = PAST;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
});

test('decide: deadline_at in the future does not block APPROVE', () => {
  assert.deepEqual(decide(validEnvelope()), { decision: 'APPROVE', reason_code: 'VALID_CONDITION' });
});

test('decide: flat test-only fallback with legacy aliases → APPROVE', () => {
  const t = {
    recipient: '0xabc',
    expectedRecipient: '0xABC',
    amount: 500,
    maximum: 1000,
    minimum: 400,
    publicBalance: 500,
    expiry_block: 8430000,
    current_block: 8420000,
    proofVk: 'vk-1',
    expectedVk: 'vk-1',
  };
  assert.deepEqual(decide(t), { decision: 'APPROVE', reason_code: 'VALID_CONDITION' });
});

test('decide: extra fields are tolerated and ignored → APPROVE', () => {
  const t = validEnvelope();
  t.input.extra = { nested: true };
  t.round = 'practice';
  assert.deepEqual(decide(t), { decision: 'APPROVE', reason_code: 'VALID_CONDITION' });
});

test('decide: big integer strings compare exactly (no float precision loss)', () => {
  const t = validEnvelope();
  t.input.amount = '1000000000000000000001';
  t.input.max_transfer = '1000000000000000000000';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
  const t2 = validEnvelope();
  t2.input.amount = '1000000000000000000000';
  t2.input.max_transfer = '1000000000000000000000';
  assert.deepEqual(decide(t2), { decision: 'APPROVE', reason_code: 'VALID_CONDITION' });
});

test('decide: non-object input → REJECT / VK_SUBSTITUTION', () => {
  assert.deepEqual(decide(null), { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' });
  assert.deepEqual(decide('nope'), { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' });
});

// --- HMAC unit tests ---------------------------------------------------------

test('hmac: sign/verify round-trip over the raw body', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  const sig = sign(TEST_SECRET, raw);
  assert.equal(sig.length, 64);
  assert.equal(verify(TEST_SECRET, raw, sig), true);
});

test('hmac: verify rejects a wrong secret', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  assert.equal(verify('other-secret', raw, sign(TEST_SECRET, raw)), false);
});

test('hmac: verify rejects a missing header and a malformed value', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  assert.equal(verify(TEST_SECRET, raw, undefined), false);
  assert.equal(verify(TEST_SECRET, raw, 'not-hex'), false);
  assert.equal(verify(TEST_SECRET, raw, ''), false);
});

test('hmac: verify accepts the sha256= prefixed form', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  assert.equal(verify(TEST_SECRET, raw, `sha256=${sign(TEST_SECRET, raw)}`), true);
});

test('hmac: verify rejects a tampered body', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  const sig = sign(TEST_SECRET, raw);
  assert.equal(verify(TEST_SECRET, Buffer.from('{"a":2}', 'utf8'), sig), false);
});

// --- proof module: real implementation --------------------------------------
// The circuit artifacts ship in circuits/, so hasArtifacts is true; the
// module is "configured" only once a Kurier API key is also set (the key
// needs the operator's kurier.xyz account). These tests run with the key
// unset unless a test sets it explicitly (saved + restored).

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Decision inputs for a real proof, from the valid envelope + a decision. */
function proofInputsForTest(envelope, decision) {
  const input = envelope.input;
  return {
    taskId: envelope.task_id,
    registeredVk: input.registered_vk,
    proofVk: input.proof_vk,
    recipient: input.recipient,
    conditionRecipient: input.condition_recipient,
    amount: input.amount,
    maxTransfer: input.max_transfer,
    minimum: input.minimum,
    publicBalance: input.public_balance,
    expiryBlock: input.expiry_block,
    currentBlock: input.current_block,
    decision,
  };
}

test('proof: status without a Kurier key is not configured (artifacts present, key missing)', async () => {
  await withEnv({ KURIER_API_KEY: undefined }, () => {
    const status = proof.getProofStatus();
    assert.equal(status.configured, false);
    assert.equal(status.hasArtifacts, true);
    assert.equal(status.snarkjsAvailable, true);
    assert.equal(status.kurierConfigured, false);
    assert.equal(status.vkHash, proof.GATEKEEPER_VK_HASH);
  });
});

test('proof: proveDecision without a Kurier key returns ok:false, no fake proof', async () => {
  await withEnv({ KURIER_API_KEY: undefined }, async () => {
    const r = await proof.proveDecision(proofInputsForTest(validEnvelope(), 'APPROVE'));
    assert.equal(r.ok, false);
    assert.equal(r.proof, undefined);
    assert.match(r.reason, /KURIER_API_KEY/);
  });
});

test('proof: generateProof produces a real locally-verifying proof (APPROVE case)', async () => {
  const snarkjs = require('snarkjs');
  const { buildPoseidon } = require('circomlibjs');
  const inputs = proofInputsForTest(validEnvelope(), 'APPROVE');
  const r = await proof.generateProof(inputs);
  assert.equal(r.ok, true);
  assert.equal(typeof r.proof, 'object');
  assert.ok(r.proof.pi_a && r.proof.pi_b && r.proof.pi_c, 'groth16 proof shape');
  assert.equal(r.publicSignals.length, 13);
  // Public signals follow the documented layout: [Poseidon(salt, taskId),
  // registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
  // currentBlock, recipient, conditionRecipient, amount, maxTransfer,
  // decision, taskId].
  const circuitInputs = proof.buildCircuitInputs(inputs);
  assert.equal(r.publicSignals[1], circuitInputs.registeredVkHash.toString());
  assert.equal(r.publicSignals[2], circuitInputs.proofVkHash.toString());
  assert.equal(r.publicSignals[3], '1000'); // minimum
  assert.equal(r.publicSignals[4], '1460'); // publicBalance
  assert.equal(r.publicSignals[11], '1'); // decision APPROVE
  assert.equal(r.publicSignals[12], circuitInputs.taskId.toString());
  const poseidon = await buildPoseidon();
  assert.equal(
    poseidon.F.toString(poseidon([circuitInputs.salt, circuitInputs.taskId])),
    r.publicSignals[0],
    'public signal 0 is Poseidon(salt, taskId)',
  );
  const vk = await snarkjs.zKey.exportVerificationKey(
    path.join(__dirname, 'circuits', 'gatekeeper_final.zkey'),
  );
  assert.equal(await snarkjs.groth16.verify(vk, r.publicSignals, r.proof), true);
});

test('proof: generateProof for a REJECT decision on a mismatched task verifies too', async () => {
  const snarkjs = require('snarkjs');
  const t = validEnvelope();
  t.input.recipient = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const r = await proof.generateProof(proofInputsForTest(t, 'REJECT'));
  assert.equal(r.ok, true);
  assert.equal(r.publicSignals[11], '0'); // decision REJECT
  const vk = await snarkjs.zKey.exportVerificationKey(
    path.join(__dirname, 'circuits', 'gatekeeper_final.zkey'),
  );
  assert.equal(await snarkjs.groth16.verify(vk, r.publicSignals, r.proof), true);
});

test('proof: generateProof with a decision inconsistent with the checks fails (circuit asserts)', async () => {
  // Fully valid task but decision REJECT: the circuit enforces decision
  // correctness, so witness generation must fail — never a proof.
  const r = await proof.generateProof(proofInputsForTest(validEnvelope(), 'REJECT'));
  assert.equal(r.ok, false);
  assert.equal(r.proof, undefined);
});

test('proof: buildCircuitInputs is deterministic (same task → same salt + taskId)', () => {
  const a = proof.buildCircuitInputs(proofInputsForTest(validEnvelope(), 'APPROVE'));
  const b = proof.buildCircuitInputs(proofInputsForTest(validEnvelope(), 'APPROVE'));
  assert.equal(a.salt.toString(), b.salt.toString());
  assert.equal(a.taskId.toString(), b.taskId.toString());
  assert.equal(proof.deriveSalt('gk_901').toString(), a.salt.toString());
});

/** Stub fetch that records calls and plays a canned Kurier conversation. */
function kurierStub({ jobStates = ['Submitted', 'Finalized'], submitStatus = 200 } = {}) {
  const calls = [];
  let statusIdx = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/submit-proof/')) {
      return {
        ok: submitStatus >= 200 && submitStatus < 300,
        status: submitStatus,
        json: async () => ({ jobId: 'job_test_1' }),
      };
    }
    const state = jobStates[Math.min(statusIdx, jobStates.length - 1)];
    statusIdx += 1;
    return { ok: true, status: 200, json: async () => ({ status: state }) };
  };
  return { fetchImpl, calls };
}

test('proof: submitProof with a stubbed fetch reaches Finalized without network', async () => {
  await withEnv({ KURIER_API_KEY: 'test-key-do-not-use' }, async () => {
    const { fetchImpl, calls } = kurierStub();
    const r = await proof.submitProof({ pi_a: ['1', '2'], pi_b: [['1', '2'], ['3', '4']], pi_c: ['5', '6'], protocol: 'groth16', curve: 'bn128' }, ['1', '2'], { fetchImpl, pollMs: 5, budgetMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'Finalized');
    assert.equal(r.jobId, 'job_test_1');
    // Submit call: key in the path (never a header), Playbook body shape.
    const submit = calls.find((c) => c.url.includes('/submit-proof/'));
    assert.ok(submit, 'submit call recorded');
    assert.equal(submit.url, 'https://api.kurier.xyz/api/v1/submit-proof/test-key-do-not-use');
    assert.equal(submit.init.headers.authorization, undefined);
    const body = JSON.parse(submit.init.body);
    assert.equal(body.proofType, 'groth16');
    assert.equal(body.vkRegistered, true);
    assert.deepEqual(body.proofOptions, { library: 'snarkjs', curve: 'bn128' });
    assert.equal(body.proofData.vk, proof.GATEKEEPER_VK_HASH);
    assert.deepEqual(body.proofData.publicSignals, ['1', '2']);
    // Poll call: GET job-status with the same key + job id.
    const poll = calls.find((c) => c.url.includes('/job-status/'));
    assert.ok(poll, 'poll call recorded');
    assert.equal(poll.url, 'https://api.kurier.xyz/api/v1/job-status/test-key-do-not-use/job_test_1');
  });
});

test('proof: submitProof without a key never calls fetch', async () => {
  await withEnv({ KURIER_API_KEY: undefined }, async () => {
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      throw new Error('must not be called');
    };
    const r = await proof.submitProof({}, ['1'], { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(called, 0);
    assert.match(r.reason, /KURIER_API_KEY/);
  });
});

test('proof: submitProof surfaces a non-OK submit response', async () => {
  await withEnv({ KURIER_API_KEY: 'test-key-do-not-use' }, async () => {
    const r = await proof.submitProof({}, ['1'], {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /401/);
  });
});

test('proof: proveDecision end-to-end with stubbed fetch returns a finalized proof', async () => {
  await withEnv({ KURIER_API_KEY: 'test-key-do-not-use' }, async () => {
    const { fetchImpl } = kurierStub();
    const r = await proof.proveDecision(proofInputsForTest(validEnvelope(), 'APPROVE'), {
      fetchImpl,
      pollMs: 5,
      budgetMs: 10000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'Finalized');
    assert.equal(r.jobId, 'job_test_1');
    assert.ok(r.proof && r.proof.pi_a);
    assert.equal(r.publicSignals.length, 13);
  });
});

// --- HTTP service ------------------------------------------------------------

const TEST_PORT = 34567;
const NO_SECRET_PORT = 34568;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const NO_SECRET_BASE = `http://127.0.0.1:${NO_SECRET_PORT}`;

/** Independent client-side HMAC (node:crypto, not the module under test). */
function clientSign(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function signedHeaders(rawBody) {
  return {
    'content-type': 'application/json',
    [HEADER]: clientSign(TEST_SECRET, rawBody),
  };
}

/** Check a response's x-agent-games-signature against its raw body. */
async function assertSignedResponse(res) {
  const raw = Buffer.from(await res.arrayBuffer());
  const sig = res.headers.get(HEADER);
  assert.ok(sig, 'response must carry an x-agent-games-signature header');
  assert.equal(verify(TEST_SECRET, raw, sig), true);
  assert.equal(sig, clientSign(TEST_SECRET, raw));
  return JSON.parse(raw.toString('utf8'));
}

async function waitForHealth(base, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - started > timeoutMs) throw new Error(`server did not come up at ${base}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('http: server boots, /health answers (unsigned)', async (t) => {
  // Proof env stripped on purpose: this test asserts the decision path
  // returns no proof fields, which requires PROOF_ENABLED off / no key.
  const { KURIER_API_KEY: _k, PROOF_ENABLED: _p, ...envNoProof } = process.env;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...envNoProof, PORT: String(TEST_PORT), AGENT_GAMES_HMAC_SECRET: TEST_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await waitForHealth(BASE);

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.deepEqual(health, { status: 'ok', agent: 'rise' });
  // Health is a plain liveness check — it is not signed.
  const healthRes = await fetch(`${BASE}/health`);
  assert.equal(healthRes.headers.get(HEADER), null);

  // Signed valid task → 200 APPROVE, proof_tx echoed, response signed,
  // and no proof fields (proof module is not configured).
  const body = JSON.stringify(validEnvelope());
  const ok = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
  });
  assert.equal(ok.status, 200);
  const okJson = await assertSignedResponse(ok);
  assert.equal(okJson.decision, 'APPROVE');
  assert.equal(okJson.reason_code, 'VALID_CONDITION');
  assert.equal(okJson.proof_tx, validEnvelope().input.proof_tx);
  assert.equal(okJson.proof, undefined);
  assert.equal(okJson.public_signals, undefined);

  // Signed tampered-VK task → 200 REJECT / VK_SUBSTITUTION, signed.
  const tampered = validEnvelope();
  tampered.input.proof_vk = '0x13000000000000000000000000000000000000000000000000000000000000aa';
  const tamperedBody = JSON.stringify(tampered);
  const bad = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: signedHeaders(tamperedBody),
    body: tamperedBody,
  });
  assert.equal(bad.status, 200);
  const badJson = await assertSignedResponse(bad);
  assert.deepEqual(
    { decision: badJson.decision, reason_code: badJson.reason_code },
    { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' },
  );

  // Signed preflight → 200 {ok:true, protocolVersion:"v1"}, signed.
  const preflight = JSON.stringify({
    type: 'agent-games.preflight.v1',
    agent_id: 'ag1_test',
    issued_at: '2026-11-14T00:00:00Z',
    nonce: 'abc123',
  });
  const pre = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: signedHeaders(preflight),
    body: preflight,
  });
  assert.equal(pre.status, 200);
  const preJson = await assertSignedResponse(pre);
  assert.deepEqual(preJson, { ok: true, protocolVersion: 'v1' });

  // Missing HMAC → 401, no decision in the body.
  const noSig = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(noSig.status, 401);
  const noSigJson = await noSig.json();
  assert.equal(noSigJson.decision, undefined);
  assert.equal(noSigJson.error, 'invalid signature');

  // Bad HMAC → 401.
  const wrongSig = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HEADER]: clientSign('wrong-secret', body),
    },
    body,
  });
  assert.equal(wrongSig.status, 401);

  // Malformed JSON with a VALID signature → 400 (auth passes, parse fails).
  const malformedBody = '{not json';
  const malformed = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: signedHeaders(malformedBody),
    body: malformedBody,
  });
  assert.equal(malformed.status, 400);

  // Unknown message type (signed) → 400.
  const unknownBody = JSON.stringify({ type: 'agent-games.something-else.v1' });
  const unknown = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: signedHeaders(unknownBody),
    body: unknownBody,
  });
  assert.equal(unknown.status, 400);

  // Stale task (deadline_at in the past, signed) → 200 REJECT / THRESHOLD_MISMATCH.
  const stale = validEnvelope();
  stale.deadline_at = PAST;
  const staleBody = JSON.stringify(stale);
  const staleRes = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: signedHeaders(staleBody),
    body: staleBody,
  });
  assert.equal(staleRes.status, 200);
  const staleJson = await staleRes.json();
  assert.deepEqual(
    { decision: staleJson.decision, reason_code: staleJson.reason_code },
    { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' },
  );
});

test('http: server without a secret refuses every POST (fail closed)', async (t) => {
  const { AGENT_GAMES_HMAC_SECRET: _drop, KURIER_API_KEY: _k, PROOF_ENABLED: _p, ...envNoSecret } = process.env;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...envNoSecret, PORT: String(NO_SECRET_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await waitForHealth(NO_SECRET_BASE);

  // Health still answers (unsigned liveness check).
  const health = await (await fetch(`${NO_SECRET_BASE}/health`)).json();
  assert.deepEqual(health, { status: 'ok', agent: 'rise' });

  // POST is refused even with a syntactically valid signature.
  const body = JSON.stringify(validEnvelope());
  const res = await fetch(`${NO_SECRET_BASE}/agent`, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
  });
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.error, 'hmac secret not configured');
  assert.equal(json.decision, undefined);
});
