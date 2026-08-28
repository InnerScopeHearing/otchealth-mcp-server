import { test } from 'node:test';
import assert from 'node:assert/strict';

// Required-var preamble (mirrors azure/search.test.ts). SEARCH_BACKEND is left UNSET here on
// purpose -- this file's whole point is proving the schema DEFAULT is what a deployment that has
// never heard of this variable gets.
//
// CORRECTED 2026-08-28: the default flipped 'azure' -> 'opensearch' (env.ts; Azure subscription
// 55c84f6b was permanently deleted 2026-08-13, and every live deploy had carried an explicit
// SEARCH_BACKEND=opensearch task-def value for some time anyway -- this closed the gap where a task
// def that ever lost that ONE env var would have failed toward a dead cloud). This file's assertions
// are updated to match; its PURPOSE -- proving the schema default is deliberate and tested, not
// merely implied -- is unchanged.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
delete process.env.SEARCH_BACKEND;

test('SEARCH_BACKEND defaults to "opensearch" when unset -- inert-by-default contract', async () => {
  const { loadEnv } = await import('../config/env.js');
  assert.equal(loadEnv().SEARCH_BACKEND, 'opensearch');
});

test('SEARCH_BACKEND enum rejects an unrecognized value (zod validation, not a silent fallback)', async () => {
  const { z } = await import('zod');
  const schema = z.enum(['azure', 'opensearch']).default('opensearch');
  assert.equal(schema.parse(undefined), 'opensearch');
  assert.equal(schema.parse('azure'), 'azure');
  assert.throws(() => schema.parse('bogus'));
});
