/**
 * Spend-guard tests. These matter because the thing being bounded is not an error path: a looping
 * agent invoking Hyperagent is a BILLING event that otherwise succeeds every time, so nothing else
 * in the stack would notice it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetInvocationBudgetForTests, checkInvocationBudget, invocationLimit } from './rate-limit.js';

beforeEach(() => {
  __resetInvocationBudgetForTests();
  delete process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR;
});

test('a lane is allowed up to the limit and refused on the next call', () => {
  const limit = invocationLimit();
  for (let i = 1; i <= limit; i++) {
    const v = checkInvocationBudget('cto');
    assert.equal(v.allowed, true, `call ${i} of ${limit} must be allowed`);
    assert.equal(v.used, i);
  }
  const over = checkInvocationBudget('cto');
  assert.equal(over.allowed, false);
  assert.ok(over.retryAfterSeconds && over.retryAfterSeconds > 0, 'a refusal must say when to retry');
});

test('lanes are budgeted INDEPENDENTLY, so one looping lane cannot starve the others', () => {
  const limit = invocationLimit();
  for (let i = 0; i < limit; i++) checkInvocationBudget('cro');
  assert.equal(checkInvocationBudget('cro').allowed, false, 'cro is exhausted');
  assert.equal(checkInvocationBudget('developer').allowed, true, 'developer is unaffected');
  assert.equal(checkInvocationBudget('cfo').allowed, true, 'cfo is unaffected');
});

test('the window SLIDES: invocations older than an hour stop counting', () => {
  const t0 = 1_000_000_000_000;
  const limit = invocationLimit();
  for (let i = 0; i < limit; i++) checkInvocationBudget('cto', t0);
  assert.equal(checkInvocationBudget('cto', t0).allowed, false, 'exhausted inside the window');
  // 61 minutes later the whole burst has aged out.
  assert.equal(checkInvocationBudget('cto', t0 + 61 * 60_000).allowed, true);
});

test('a refused call does NOT consume budget, so a blocked lane cannot dig itself deeper', () => {
  const t0 = 1_000_000_000_000;
  const limit = invocationLimit();
  for (let i = 0; i < limit; i++) checkInvocationBudget('cto', t0);
  const first = checkInvocationBudget('cto', t0);
  const second = checkInvocationBudget('cto', t0);
  assert.equal(first.allowed, false);
  assert.equal(second.allowed, false);
  assert.equal(first.used, second.used, 'a refusal must not increment the counter');
});

test('the limit is re-read from env per call, so it can be raised without a redeploy', () => {
  process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR = '2';
  assert.equal(invocationLimit(), 2);
  assert.equal(checkInvocationBudget('cto').allowed, true);
  assert.equal(checkInvocationBudget('cto').allowed, true);
  assert.equal(checkInvocationBudget('cto').allowed, false);
});

test('a malformed or non-positive limit falls back to the default rather than to zero or infinity', () => {
  for (const bad of ['0', '-5', 'abc', '']) {
    process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR = bad;
    assert.equal(invocationLimit(), 20, `"${bad}" must not disable or unbound the guard`);
  }
});

test('an empty caller identity is budgeted under its own key, not shared with a named lane', () => {
  const limit = invocationLimit();
  for (let i = 0; i < limit; i++) checkInvocationBudget('');
  assert.equal(checkInvocationBudget('').allowed, false);
  assert.equal(checkInvocationBudget('cto').allowed, true);
});
