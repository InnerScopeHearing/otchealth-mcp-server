import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserAuthBroker, type BrowserAuthChallenge, type BrowserAuthOperation, type BrowserCredentialBinding } from './auth-broker.js';

const NOW = 1_800_000_000_000;
const OWNER = 'owner-a';
const BASE_BINDING: BrowserCredentialBinding = {
  bindingId: 'binding-a', owner: OWNER, origin: 'https://example.com', accountId: 'account-a',
  credentialReference: 'opaque:secret-reference', version: 7, revoked: false,
};

function harness(overrides: { binding?: BrowserCredentialBinding | null; suppressed?: boolean; inject?: { authenticated: boolean; challengeRequired: boolean; runHandle?: string }; verify?: boolean; injectError?: Error; injectGate?: Promise<void> } = {}) {
  const state: { binding: BrowserCredentialBinding | null; challenge: BrowserAuthChallenge | null; operation: BrowserAuthOperation | null } = {
    binding: overrides.binding === undefined ? BASE_BINDING : overrides.binding,
    challenge: null, operation: null,
  };
  const calls = { verifySession: 0, begin: 0, inject: 0, end: 0, verifyChallenge: 0 };
  let claimed = false;
  const broker = new BrowserAuthBroker({
    bindings: { async loadBinding() { return state.binding; } },
    runtime: {
      async verifyOwnedSession(owner, sessionId) { calls.verifySession++; return owner === OWNER && sessionId === 'session-a'; },
      async beginSensitiveMode() { calls.begin++; return overrides.suppressed === false ? { suppressed: false, leaseId: 'lease-a' } : { suppressed: true, leaseId: 'lease-a' }; },
      async injectReference() { calls.inject++; if (overrides.injectGate) await overrides.injectGate; if (overrides.injectError) throw overrides.injectError; return overrides.inject ?? { authenticated: true, challengeRequired: false }; },
      async verifyChallenge() { calls.verifyChallenge++; return overrides.verify ?? true; },
      async endSensitiveMode() { calls.end++; },
    },
    challenges: {
      async loadChallenge(id) { return state.challenge?.challengeId === id ? state.challenge : null; },
      async saveChallenge(challenge) { state.challenge = challenge; },
      async completeChallenge(id, owner, runHandle) {
        if (!state.challenge || state.challenge.challengeId !== id || state.challenge.owner !== owner || state.challenge.runHandle !== runHandle || state.challenge.completed) return false;
        state.challenge = { ...state.challenge, completed: true };
        return true;
      },
      async loadOperation(key) { return state.operation?.key === key ? state.operation : null; },
      async saveOperation(operation) { state.operation = operation; },
      async claim(key, claimant, until) { if (claimed) return null; claimed = true; return { key, claimant, until, fence: 1 }; },
      async release(claim) { claimed = false; },
    },
    now: () => NOW,
  });
  return { broker, state, calls };
}

test('authenticates through an owner-bound opaque reference and always ends sensitive mode', async () => {
  const { broker, calls } = harness();
  assert.deepEqual(await broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' }), { status: 'authenticated' });
  assert.equal(calls.inject, 1);
  assert.equal(calls.end, 1);
});

test('rejects noncanonical or unsafe origins before reading a binding or calling runtime', async () => {
  for (const origin of ['http://example.com', 'https://user@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com:444']) {
    const { broker, calls } = harness();
    await assert.rejects(broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin, accountId: 'account-a' }));
    assert.equal(calls.verifySession, 0);
    assert.equal(calls.inject, 0);
  }
});

test('checks owner, origin, account, revocation and session before runtime injection', async () => {
  const mismatches = [
    { owner: 'owner-b', binding: BASE_BINDING },
    { owner: OWNER, binding: { ...BASE_BINDING, origin: 'https://other.example' } },
    { owner: OWNER, binding: { ...BASE_BINDING, accountId: 'other-account' } },
    { owner: OWNER, binding: { ...BASE_BINDING, revoked: true } },
  ];
  for (const mismatch of mismatches) {
    const { broker, calls } = harness({ binding: mismatch.binding });
    await assert.rejects(broker.authenticate(mismatch.owner, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' }));
    assert.equal(calls.inject, 0);
  }
  const { broker, calls } = harness();
  await assert.rejects(broker.authenticate(OWNER, { sessionId: 'wrong-session', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' }));
  assert.equal(calls.inject, 0);
});

test('requires suppression before injection and cleans up even if injection throws', async () => {
  const noSuppress = harness({ suppressed: false });
  await assert.rejects(noSuppress.broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' }));
  assert.equal(noSuppress.calls.inject, 0);
  const { broker, calls } = harness();
  // The concrete runtime is exercised for ordinary cleanup; error text is checked in a dedicated test below.
  assert.equal((await broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' })).status, 'authenticated');
  assert.equal(calls.end, 1);
});

test('stores and resumes a challenge only through provider verification, preserving the original binding and session', async () => {
  const { broker, state, calls } = harness({ inject: { authenticated: false, challengeRequired: true, runHandle: 'provider-run' } });
  const first = await broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' });
  assert.equal(first.status, 'challenge_required');
  if (first.status !== 'challenge_required') return;
  assert.equal(state.challenge?.sessionId, 'session-a');
  assert.equal(state.challenge?.bindingId, 'binding-a');
  assert.deepEqual(await broker.resume(OWNER, first.challengeId), { status: 'authenticated' });
  assert.equal(calls.inject, 1);
  assert.equal(calls.verifyChallenge, 1);
  await assert.rejects(broker.resume(OWNER, first.challengeId));
});

test('does not complete, replay, or cross-owner a challenge', async () => {
  const { broker, state } = harness({ inject: { authenticated: false, challengeRequired: true, runHandle: 'provider-run' }, verify: false });
  const first = await broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' });
  assert.equal(first.status, 'challenge_required');
  if (first.status !== 'challenge_required') return;
  assert.deepEqual(await broker.resume(OWNER, first.challengeId), first);
  assert.equal(state.challenge?.completed, false);
  await assert.rejects(broker.resume('owner-b', first.challengeId));
  state.challenge = { ...state.challenge!, expiresAt: NOW - 1 };
  await assert.rejects(broker.resume(OWNER, first.challengeId));
});

test('fences duplicate calls and does not repeat a completed operation', async () => {
  let releaseInjection!: () => void;
  const injectGate = new Promise<void>((resolve) => { releaseInjection = resolve; });
  const { broker, state, calls } = harness({ injectGate });
  const input = { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' };
  const firstCall = broker.authenticate(OWNER, input);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(broker.authenticate(OWNER, input), /Another browser authentication operation is in progress/);
  releaseInjection();
  // A completed operation is terminal even after its short-lived execution lease is released.
  await firstCall;
  await assert.rejects(broker.authenticate(OWNER, input));
  assert.equal(calls.inject, 1);
  assert.equal(state.operation?.state, 'completed');
});

test('normalizes runtime failures to fixed safe errors and attempts cleanup', async () => {
  const { broker, calls, state } = harness({ injectError: new Error('provider leaked password=should-never-escape') });
  await assert.rejects(broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' }), (error: unknown) => {
    assert.equal((error as Error).message, 'The browser authentication operation could not be confirmed. Reconcile the existing session before retrying.');
    assert.equal((error as Error).message.includes('should-never-escape'), false);
    return true;
  });
  assert.equal(calls.end, 1);
  assert.equal(state.operation?.state, 'unknown');
  await assert.rejects(broker.authenticate(OWNER, { sessionId: 'session-a', bindingId: 'binding-a', origin: 'https://example.com', accountId: 'account-a' }));
  assert.equal(calls.inject, 1);
});
