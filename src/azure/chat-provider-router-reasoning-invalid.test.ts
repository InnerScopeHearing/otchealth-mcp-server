import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call. This file proves the VALIDATION half of
// OPENAI_ROUTER_REASONING_EFFORT's contract: an invalid value fails loudly at load time (a
// zod-validated enum, like PERPLEXITY_CONNECTOR_TOKEN's length check elsewhere in this schema),
// rather than being silently swallowed the way most of this file's OTHER mode/kill-switch string
// flags (DEEP_RETRIEVAL_MODE, ENTITY_LOOKUP_MODE) are. Lives alongside the sibling
// chat-provider-router-reasoning-{off,custom}.test.ts files (the "env validation" branch the task
// brief calls out, next to the "kill-switch"/"provider gating" branches those files cover).
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.OPENAI_ROUTER_REASONING_EFFORT = 'bogus-value';

const { loadEnv } = await import('../config/env.js');

test('an invalid OPENAI_ROUTER_REASONING_EFFORT value fails loudly at loadEnv(), never silently defaults', () => {
  assert.throws(
    () => loadEnv(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /OPENAI_ROUTER_REASONING_EFFORT/);
      return true;
    },
  );
});

test('the failure is consistent across repeated calls (the bad parse is never cached as a false success)', () => {
  assert.throws(() => loadEnv());
  assert.throws(() => loadEnv());
});
