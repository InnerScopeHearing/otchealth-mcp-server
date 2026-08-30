import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupCallTimeoutMs, AgentCoreBrowserTransportError, cdpCommandEnvelope, evaluatedResult } from './transport.js';

// FND-20260829-e454: browser_broker_inspect_public's transport had ~75s of independent setup-step
// timeouts (session start 20s + CDP connect 15s + Target.getTargets 20s + Target.attachToTarget
// 20s) BEFORE the per-target loop even began, entirely independent of the caller's `max_seconds` --
// so shrinking max_seconds' schema bound alone would not have fixed the real worst case. These
// tests cover the pure policy extracted out of inspect()'s closure (setupCallTimeoutMs) directly,
// since the surrounding class makes real AWS SigV4-signed HTTPS/WSS calls that this repo does not
// otherwise mock (no existing transport.test.ts pre-dates this fix).

test('setupCallTimeoutMs: caps at min(remaining, ceiling) when time is left', () => {
  assert.equal(setupCallTimeoutMs(10_000, 20_000), 10_000);
  assert.equal(setupCallTimeoutMs(30_000, 20_000), 20_000);
  assert.equal(setupCallTimeoutMs(1, 20_000), 1);
});

test('setupCallTimeoutMs: throws provider_timeout immediately (no doomed call attempted) once the deadline has already passed', () => {
  for (const remaining of [0, -1, -50_000]) {
    assert.throws(
      () => setupCallTimeoutMs(remaining, 20_000),
      (err: unknown) => err instanceof AgentCoreBrowserTransportError && err.code === 'provider_timeout',
      `remaining=${remaining} must throw provider_timeout, not attempt a call with a non-positive timeout`,
    );
  }
});

test('setupCallTimeoutMs: this is the SAME policy for every setup step -- a caller composes it identically for the 20s/15s/20s/20s ceilings (session start/connect/getTargets/attachToTarget)', () => {
  // Simulates the four setup calls sharing one deadline, each consuming some of the remaining
  // budget: session start (ceiling 20s), connect (ceiling 15s), getTargets (20s), attachToTarget
  // (20s). With only 5s actually left before the first call, every subsequent step gets LESS time
  // than its own ceiling, never more -- proving the steps genuinely share one bounded pool rather
  // than each getting an independent allowance.
  let remaining = 5_000;
  const consumed = [3_000, 1_000, 500, 400]; // what each fake step "took"
  const ceilings = [20_000, 15_000, 20_000, 20_000];
  const grantedTimeouts: number[] = [];
  for (let i = 0; i < ceilings.length; i++) {
    grantedTimeouts.push(setupCallTimeoutMs(remaining, ceilings[i]!));
    remaining -= consumed[i]!;
  }
  assert.deepEqual(grantedTimeouts, [5_000, 2_000, 1_000, 500]);
  for (const g of grantedTimeouts) assert.ok(g <= 20_000, 'never exceeds its own ceiling');
  // The 5th hypothetical step (remaining is now 5000-3000-1000-500-400=100) still gets a bounded,
  // positive timeout rather than silently reusing a stale allowance.
  assert.equal(setupCallTimeoutMs(remaining, 20_000), 100);
});

// --- cdpCommandEnvelope / evaluatedResult: small pure helpers, worth locking their exact shape ---

test('cdpCommandEnvelope: builds the CDP JSON-RPC envelope, sessionId omitted when absent', () => {
  assert.deepEqual(cdpCommandEnvelope(1, 'Target.getTargets', {}), { id: 1, method: 'Target.getTargets', params: {} });
  assert.deepEqual(cdpCommandEnvelope(2, 'Page.navigate', { url: 'https://example.test' }, 'sess-1'), {
    id: 2,
    method: 'Page.navigate',
    params: { url: 'https://example.test' },
    sessionId: 'sess-1',
  });
});

test('evaluatedResult: parses the bounded public-page receipt out of Runtime.evaluate\'s JSON string result', () => {
  const raw = { result: { value: JSON.stringify({ title: 'A Title', url: 'https://example.test/page', status: 200 }) } };
  assert.deepEqual(evaluatedResult(raw), { title: 'A Title', url: 'https://example.test/page', status: 200 });
});

test('evaluatedResult: a non-string / missing result.value throws provider_result_invalid rather than returning garbage', () => {
  assert.throws(
    () => evaluatedResult({ result: { value: 42 } }),
    (err: unknown) => err instanceof AgentCoreBrowserTransportError && err.code === 'provider_result_invalid',
  );
  assert.throws(
    () => evaluatedResult({}),
    (err: unknown) => err instanceof AgentCoreBrowserTransportError && err.code === 'provider_result_invalid',
  );
});

test('evaluatedResult: an unparseable JSON string in result.value throws provider_result_invalid, never a raw parse error', () => {
  assert.throws(
    () => evaluatedResult({ result: { value: 'not json {{{' } }),
    (err: unknown) => err instanceof AgentCoreBrowserTransportError && err.code === 'provider_result_invalid',
  );
});
