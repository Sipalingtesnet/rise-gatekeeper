'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { decide } = require('./decide');

const validTask = () => ({
  id: 'gk_901',
  recipient: '0xD0620000000000000000000000000000009F81',
  expectedRecipient: '0xd0620000000000000000000000000000009f81',
  amount: 1000,
  maximum: 1000,
  proofVk: 'vk-abc-123',
  expectedVk: 'vk-abc-123',
});

// --- pure decision logic ---------------------------------------------------

test('decide: fully valid task → APPROVE / VALID_CONDITION', () => {
  assert.deepEqual(decide(validTask()), { decision: 'APPROVE', reason: 'VALID_CONDITION' });
});

test('decide: amount exactly at maximum is still APPROVE (boundary)', () => {
  const t = validTask();
  t.amount = 1000;
  t.maximum = 1000;
  assert.deepEqual(decide(t), { decision: 'APPROVE', reason: 'VALID_CONDITION' });
});

test('decide: VK mismatch → REJECT / VK_SUBSTITUTION', () => {
  const t = validTask();
  t.proofVk = 'vk-tampered-999';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'VK_SUBSTITUTION' });
});

test('decide: recipient mismatch → REJECT / RECIPIENT_MISMATCH', () => {
  const t = validTask();
  t.recipient = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'RECIPIENT_MISMATCH' });
});

test('decide: amount above maximum → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validTask();
  t.amount = 1460;
  t.maximum = 1000;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'THRESHOLD_MISMATCH' });
});

test('decide: amount as string above maximum → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validTask();
  t.amount = '1460';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'THRESHOLD_MISMATCH' });
});

test('decide: missing expectedVk fails closed → REJECT / VK_SUBSTITUTION', () => {
  const t = validTask();
  delete t.expectedVk;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'VK_SUBSTITUTION' });
});

test('decide: missing expectedRecipient fails closed → REJECT / RECIPIENT_MISMATCH', () => {
  const t = validTask();
  delete t.expectedRecipient;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'RECIPIENT_MISMATCH' });
});

test('decide: missing maximum fails closed → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validTask();
  delete t.maximum;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'THRESHOLD_MISMATCH' });
});

test('decide: negative amount → REJECT / THRESHOLD_MISMATCH', () => {
  const t = validTask();
  t.amount = -5;
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'THRESHOLD_MISMATCH' });
});

test('decide: alias field names (threshold / publicBalance / vk) → APPROVE', () => {
  const t = {
    recipient: '0xabc',
    expectedRecipient: '0xABC',
    publicBalance: 500,
    threshold: 1000,
    vk: 'vk-1',
    expectedVk: 'vk-1',
  };
  assert.deepEqual(decide(t), { decision: 'APPROVE', reason: 'VALID_CONDITION' });
});

test('decide: extra fields are tolerated and ignored → APPROVE', () => {
  const t = validTask();
  t.round = 'practice';
  t.extra = { nested: true };
  assert.deepEqual(decide(t), { decision: 'APPROVE', reason: 'VALID_CONDITION' });
});

test('decide: big integer strings compare exactly (no float precision loss)', () => {
  const t = validTask();
  t.amount = '1000000000000000000001';
  t.maximum = '1000000000000000000000';
  assert.deepEqual(decide(t), { decision: 'REJECT', reason: 'THRESHOLD_MISMATCH' });
  const t2 = validTask();
  t2.amount = '1000000000000000000000';
  t2.maximum = '1000000000000000000000';
  assert.deepEqual(decide(t2), { decision: 'APPROVE', reason: 'VALID_CONDITION' });
});

// --- HTTP service ----------------------------------------------------------

const TEST_PORT = 34567;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

async function waitForHealth(timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - started > timeoutMs) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('http: server boots, /health answers, /agent decides', async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  await waitForHealth();

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.deepEqual(health, { status: 'ok', agent: 'rise' });

  const ok = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validTask()),
  });
  assert.equal(ok.status, 200);
  const okJson = await ok.json();
  assert.equal(okJson.decision, 'APPROVE');
  assert.equal(okJson.reason, 'VALID_CONDITION');
  assert.equal(okJson.agent, 'rise');
  assert.equal(okJson.taskId, 'gk_901');

  const bad = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validTask(), proofVk: 'vk-tampered' }),
  });
  const badJson = await bad.json();
  assert.deepEqual(
    { decision: badJson.decision, reason: badJson.reason },
    { decision: 'REJECT', reason: 'VK_SUBSTITUTION' },
  );

  const malformed = await fetch(`${BASE}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
});
