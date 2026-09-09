import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own node:test process: loadEnv() memoizes configuration. These are synthetic fixtures only.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.COSMOS_ENDPOINT = 'https://fixed-cosmos.example.invalid';
process.env.COSMOS_KEY = Buffer.from('synthetic-test-key-not-real').toString('base64');
delete process.env.COSMOS_AUTH_MODE;
process.env.STATE_BACKEND = 'cosmos';

const { consumeAuthCode } = await import('./oauth-tokens.js');

test('OAuth auth-code selector stays within the configured Cosmos authority', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    // A valid selector keeps the request on the configured authority and leaves safe IDs unchanged.
    assert.equal(await consumeAuthCode('a'.repeat(64)), null);
    assert.deepEqual(calls, [
      'https://fixed-cosmos.example.invalid/dbs/agent-state/colls/oauthcodes/docs/' + 'a'.repeat(64),
    ]);

    // OAuth request-body input cannot smuggle a slash or encoded slash into the Cosmos URL.
    assert.equal(await consumeAuthCode('../colls/other/docs/x'), null);
    assert.equal(await consumeAuthCode('%2F%2Fevil.example.invalid'), null);
    assert.equal(calls.length, 1, 'rejected selectors must not issue a request');
  } finally {
    globalThis.fetch = original;
  }
});
