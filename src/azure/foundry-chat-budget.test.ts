import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRequestBudget } from './foundry.js';

// Regression guard for the 2026-09-04 claims_check outage: every Foundry/OpenAI CHAT completion was
// riding fetchWithBudget's 8 s default, so a reasoning-tier model (gpt-5.6-sol) on a 3.4 KB
// JSON-mode packet aborted with "The operation was aborted due to timeout" on 4 of 5 packets.
// Chat calls now carry an explicit, env-bounded budget; embeddings keep the default.

test('chatRequestBudget: defaults to 90 s with no retry when the env var is unset', () => {
  assert.deepEqual(chatRequestBudget({}), { timeoutMs: 90_000, retries: 0 });
  assert.deepEqual(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: undefined }), { timeoutMs: 90_000, retries: 0 });
});

test('chatRequestBudget: honors an in-range FOUNDRY_CHAT_TIMEOUT_MS', () => {
  assert.deepEqual(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: 120_000 }), { timeoutMs: 120_000, retries: 0 });
  assert.deepEqual(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: 8_000 }), { timeoutMs: 8_000, retries: 0 });
  assert.deepEqual(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: 300_000 }), { timeoutMs: 300_000, retries: 0 });
});

test('chatRequestBudget: an out-of-range or non-numeric value falls back to the 90 s default (never disables the budget)', () => {
  assert.equal(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: 100 }).timeoutMs, 90_000);
  assert.equal(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: 10_000_000 }).timeoutMs, 90_000);
  assert.equal(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: Number.NaN }).timeoutMs, 90_000);
  assert.equal(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: 0 }).timeoutMs, 90_000);
});

test('chatRequestBudget: the budget is always above the 8 s fetch-budget default that broke claims_check', () => {
  for (const v of [undefined, 8_000, 45_000, 90_000, 300_000]) {
    assert.ok(chatRequestBudget({ FOUNDRY_CHAT_TIMEOUT_MS: v }).timeoutMs >= 8_000);
  }
});
