import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process (see dispatch-azure.test.ts's header comment for why this matters: loadEnv()
// caches its parsed result for the lifetime of the module, so this scenario -- OPENSEARCH_ENDPOINT
// NEVER configured -- needs a process that has not already cached a DIFFERENT env, such as
// opensearch.test.ts's own preamble, which configures a real endpoint for its many other tests).
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// AWS creds ARE set here, deliberately, to prove searchConfigured()'s endpoint check short-circuits
// to false BEFORE even looking at credentials -- an unconfigured endpoint must be false regardless
// of what credential material happens to be present.
process.env.AWS_ACCESS_KEY_ID ||= 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY ||= 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
delete process.env.OPENSEARCH_ENDPOINT;

const { hybridSearch, getDocumentByKey, searchConfigured } = await import('./opensearch.js');

test('searchConfigured: false when OPENSEARCH_ENDPOINT was never configured, regardless of AWS creds', () => {
  assert.equal(searchConfigured(), false);
});

test('hybridSearch: returns null (not a throw) when OPENSEARCH_ENDPOINT was never configured, no network call', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    throw new Error(`must never fetch when unconfigured, got: ${String(url)}`);
  }) as typeof fetch;
  try {
    assert.equal(await hybridSearch('memory-exec', 'q', 5), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('getDocumentByKey: returns null (not a throw) when OPENSEARCH_ENDPOINT was never configured, no network call', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    throw new Error(`must never fetch when unconfigured, got: ${String(url)}`);
  }) as typeof fetch;
  try {
    assert.equal(await getDocumentByKey('memory-exec', 'some-key'), null);
  } finally {
    globalThis.fetch = original;
  }
});
