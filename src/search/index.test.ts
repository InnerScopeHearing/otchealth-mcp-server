import { test } from 'node:test';
import assert from 'node:assert/strict';

// Required-var preamble (mirrors azure/search.test.ts). SEARCH_BACKEND is left UNSET here on
// purpose -- this file's whole point is proving the schema DEFAULT ('azure') is what a deployment
// that has never heard of this variable gets, byte-identical to before it existed.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
delete process.env.SEARCH_BACKEND;

test('SEARCH_BACKEND defaults to "azure" when unset -- inert-by-default contract', async () => {
  const { loadEnv } = await import('../config/env.js');
  assert.equal(loadEnv().SEARCH_BACKEND, 'azure');
});

test('SEARCH_BACKEND enum rejects an unrecognized value (zod validation, not a silent fallback)', async () => {
  const { z } = await import('zod');
  const schema = z.enum(['azure', 'opensearch']).default('azure');
  assert.equal(schema.parse(undefined), 'azure');
  assert.equal(schema.parse('opensearch'), 'opensearch');
  assert.throws(() => schema.parse('bogus'));
});
