import assert from 'node:assert/strict';
import test from 'node:test';
import { runCapabilityCanary, type CanaryProvider, type CanaryTarget } from './capability-canary.js';

const target: CanaryTarget = { principal: 'test-principal', account: 'test-account', resource: 'test-resource' };
const input = {
  target,
  intentId: 'AIOS-B07-lane-test-01',
  idempotencyKey: 'AIOS-B07-lane-test-01',
  payload: { marker: 'synthetic-canary' },
  now: () => 1_000,
  deadlineAtMs: 5_000,
  expiresAtMs: 4_000,
};

function provider(overrides: Partial<CanaryProvider> = {}) {
  const state = { record: undefined as undefined | { target: CanaryTarget; idempotencyKey: string; payload: unknown; expiresAtMs: number }, submits: 0, cleanups: 0 };
  const base: CanaryProvider = {
    submit: async (request) => {
      state.submits++;
      if (state.record && state.record.idempotencyKey === request.idempotencyKey) {
        if (JSON.stringify(state.record.payload) !== JSON.stringify(request.payload)) return { status: 'rejected', reason: 'idempotency_conflict' };
        return { status: 'submitted' };
      }
      state.record = { target: request.target, idempotencyKey: request.idempotencyKey, payload: request.payload, expiresAtMs: request.expiresAtMs };
      return { status: 'submitted' };
    },
    read: async () => state.record ? { status: 'found', record: state.record } : { status: 'absent' },
    cleanup: async () => { state.cleanups++; state.record = undefined; return { status: 'deleted' }; },
  };
  return { provider: { ...base, ...overrides }, state };
}

test('submits once, confirms exact ownership and payload, then verifies cleanup', async () => {
  const fake = provider();
  const result = await runCapabilityCanary(input, fake.provider);
  assert.equal(result.state, 'cleaned');
  assert.deepEqual(result.target, target);
  assert.equal(fake.state.submits, 1);
  assert.equal(fake.state.cleanups, 1);
  assert.equal(result.receipts.confirmed?.status, 'confirmed');
  assert.equal(result.receipts.cleanup?.status, 'confirmed');
});

test('a duplicate stable key with changed payload is rejected by the provider idempotency contract', async () => {
  const fake = provider({ cleanup: async () => ({ status: 'failed', reason: 'retain synthetic record for duplicate-key case' }) });
  await runCapabilityCanary(input, fake.provider);
  const next = await runCapabilityCanary({ ...input, payload: { marker: 'different' } }, fake.provider);
  assert.equal(next.state, 'conflict');
  assert.equal(fake.state.submits, 2);
});

test('response loss freezes the exact target without retry or speculative cleanup', async () => {
  const fake = provider({ submit: async () => { throw new Error('connection lost after request'); } });
  const result = await runCapabilityCanary(input, fake.provider);
  assert.equal(result.state, 'unknown_frozen');
  assert.deepEqual(result.target, target);
  assert.equal(fake.state.submits, 0);
  assert.equal(fake.state.cleanups, 0);
});

test('wrong owner readback is frozen and never cleaned up', async () => {
  const fake = provider({ read: async () => ({ status: 'found', record: { target: { ...target, principal: 'other' }, idempotencyKey: input.idempotencyKey, payload: input.payload, expiresAtMs: input.expiresAtMs } }) });
  const result = await runCapabilityCanary(input, fake.provider);
  assert.equal(result.state, 'wrong_owner_frozen');
  assert.equal(fake.state.cleanups, 0);
});

test('mismatched payload readback is frozen and never cleaned up', async () => {
  const fake = provider({ read: async () => ({ status: 'found', record: { target, idempotencyKey: input.idempotencyKey, payload: { marker: 'other' }, expiresAtMs: input.expiresAtMs } }) });
  const result = await runCapabilityCanary(input, fake.provider);
  assert.equal(result.state, 'conflict');
  assert.equal(fake.state.cleanups, 0);
});

test('read failure stays unknown and is not treated as absence', async () => {
  const fake = provider({ read: async () => ({ status: 'unreadable', reason: 'provider unavailable' }) });
  const result = await runCapabilityCanary(input, fake.provider);
  assert.equal(result.state, 'read_unknown_frozen');
  assert.equal(fake.state.cleanups, 0);
});

test('cleanup failure retains unresolved cleanup receipt', async () => {
  const fake = provider({ cleanup: async () => { throw new Error('cleanup failed'); } });
  const result = await runCapabilityCanary(input, fake.provider);
  assert.equal(result.state, 'cleanup_failed');
  assert.equal(result.receipts.cleanup?.status, 'failed');
});

test('expired intent does not submit or mutate', async () => {
  const fake = provider();
  const result = await runCapabilityCanary({ ...input, now: () => 5_000 }, fake.provider);
  assert.equal(result.state, 'expired');
  assert.equal(fake.state.submits, 0);
});

test('a never-settling submit is bounded by deadline and returns exact recovery identity', async () => {
  const fake = provider({ submit: async () => new Promise(() => {}) });
  const started = Date.now();
  const result = await runCapabilityCanary({ ...input, deadlineAtMs: 1_015, expiresAtMs: 1_025 }, fake.provider);
  assert.ok(Date.now() - started < 100);
  assert.equal(result.state, 'unknown_frozen');
  assert.deepEqual(result.recovery, { target, intentId: input.intentId, idempotencyKey: input.idempotencyKey, expiresAtMs: 1_025 });
  assert.equal(fake.state.cleanups, 0);
});

test('non-finite deadlines are rejected before submit', async () => {
  const fake = provider();
  const result = await runCapabilityCanary({ ...input, deadlineAtMs: Number.NaN }, fake.provider);
  assert.equal(result.state, 'invalid_input');
  assert.equal(fake.state.submits, 0);
});

test('non-finite expiry and current time are rejected before submit', async () => {
  const fake = provider();
  assert.equal((await runCapabilityCanary({ ...input, expiresAtMs: Infinity }, fake.provider)).state, 'invalid_input');
  assert.equal((await runCapabilityCanary({ ...input, now: () => Number.NaN }, fake.provider)).state, 'invalid_input');
  assert.equal(fake.state.submits, 0);
});

test('lossy and non-JSON payloads are rejected before submit', async (t) => {
  const fake = provider();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const payload of [Number.NaN, Infinity, -0, undefined, 1n, () => 'x', { missing: undefined }, cyclic]) {
    await t.test(String(payload), async () => {
      const result = await runCapabilityCanary({ ...input, payload }, fake.provider);
      assert.equal(result.state, 'invalid_input');
    });
  }
  assert.equal(fake.state.submits, 0);
});

test('JSON object key order does not change exact payload meaning', async () => {
  let reads = 0;
  const fake = provider({ read: async () => ++reads === 1
    ? ({ status: 'found', record: { target, idempotencyKey: input.idempotencyKey, payload: { z: 2, a: 1 }, expiresAtMs: input.expiresAtMs } })
    : ({ status: 'absent' }) });
  const result = await runCapabilityCanary({ ...input, payload: { a: 1, z: 2 } }, fake.provider);
  assert.equal(result.state, 'cleaned');
});
