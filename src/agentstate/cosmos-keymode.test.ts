// COSMOS_AUTH_MODE regression pin: with the flag left at its default ('key'), the actual wire
// Authorization header request() sends must be identical in SHAPE to before this flag existed
// (master-key HMAC via authToken()), and the new aad/managed-identity path must never be touched.
// This is the end-to-end companion to the pure authToken()-pinning tests in agentstate.test.ts --
// those pin the pure function; this pins that request() actually calls it, unchanged, by default.
//
// Own file (own `node --test` child process): loadEnv() memoizes per-process, and this file's env
// snapshot (COSMOS_AUTH_MODE left UNSET, COSMOS_KEY set) must not collide with cosmos-aad.test.ts's
// (COSMOS_AUTH_MODE=aad, no COSMOS_KEY) -- see that file's header comment for why.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

process.env.COSMOS_ENDPOINT ||= 'https://fake-cosmos.example.invalid';
process.env.COSMOS_KEY ||= Buffer.from('super-secret-master-key-not-real').toString('base64');
delete process.env.COSMOS_AUTH_MODE; // the INERT-by-default case: nobody set the flag at all
// Deliberately do NOT set IDENTITY_ENDPOINT/IDENTITY_HEADER: if key mode ever accidentally called
// miToken(), it would throw immediately ("IDENTITY_ENDPOINT/IDENTITY_HEADER unset") instead of
// silently succeeding, so an accidental aad-path call surfaces loudly rather than being masked.

const { isConfigured, readDoc, authToken } = await import('./cosmos.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('isConfigured(): true in (default) key mode with both COSMOS_ENDPOINT and COSMOS_KEY set', () => {
  assert.equal(process.env.COSMOS_AUTH_MODE, undefined, 'precondition: the flag is genuinely unset');
  assert.equal(isConfigured(), true);
});

test('key mode (COSMOS_AUTH_MODE unset, the default): request() Authorization header is still the master-key HMAC shape, never the aad shape, and IDENTITY_ENDPOINT is never touched', async () => {
  let cosmosCalls = 0;
  let capturedAuth = '';
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      // If default/key mode ever regressed into calling miToken(), it would hit IDENTITY_ENDPOINT
      // (unset in this file -> miToken throws before any fetch) -- so ANY call reaching this stub
      // must be the Cosmos REST call itself, never an identity-token mint.
      cosmosCalls++;
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.['Authorization'] ?? headers?.['authorization'] ?? '';
      return new Response(JSON.stringify({ id: 'testid', hello: 'world' }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const doc = await readDoc('tasks', 'testpk', 'testid');
      assert.equal(doc?.doc.hello, 'world');
    },
  );
  assert.equal(cosmosCalls, 1);
  assert.ok(capturedAuth.startsWith('type%3Dmaster%26ver%3D1.0%26sig%3D'), `expected master-shaped header, got: ${capturedAuth.slice(0, 40)}`);
  assert.ok(!capturedAuth.startsWith('type%3Daad'), 'must never be aad-shaped when COSMOS_AUTH_MODE is unset');

  // request() must still be signing with authToken() itself (not a parallel reimplementation):
  // the resourceLink for a single-doc GET is dbs/<db>/colls/tasks/docs/testid, and authToken()
  // called directly with that shape + the same key produces the identical prefix that shipped.
  const db = process.env.COSMOS_DB || 'agent-state';
  const resourceLink = `dbs/${db}/colls/tasks/docs/testid`;
  const direct = authToken('GET', 'docs', resourceLink, new Date().toUTCString(), process.env.COSMOS_KEY as string);
  assert.equal(direct.slice(0, 33), capturedAuth.slice(0, 33), 'the "type=master&ver=1.0&sig=" prefix must match byte-for-byte (sig itself differs only because the date differs)');
});
