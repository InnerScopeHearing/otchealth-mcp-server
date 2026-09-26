import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

process.env.CIO_SITE_ID ??= 'test';
process.env.CIO_TRACK_KEY ??= 'test';
process.env.CIO_APP_API_BEARER ??= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
process.env.GITHUB_APP_ID ??= '123456';
process.env.GITHUB_APP_INSTALLATION_ID ??= '789';
process.env.GITHUB_APP_PRIVATE_KEY ??= privateKey;

const { markPullRequestReadyForReview } = await import('./api-client.js');

test('GraphQL failure is sanitized and the mutation is sent exactly once without retry', async () => {
  const original = globalThis.fetch;
  const secret = 'ghs_this_must_not_escape';
  let mutationCalls = 0;
  let mutationBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) {
      return new Response(JSON.stringify({
        token: secret,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { pull_requests: 'write' },
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/graphql')) {
      mutationCalls++;
      mutationBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ errors: [{ message: `upstream included ${secret}` }] }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => markPullRequestReadyForReview('PR_kwDOExample'),
      (error: unknown) => {
        const e = error as { code?: string; message?: string };
        return e.code === 'github_pr_ready_mutation_failed' && !String(e.message).includes(secret);
      },
    );
    assert.equal(mutationCalls, 1, 'a GraphQL failure must not cause a retry of the state mutation');
    assert.match(mutationBody, /markPullRequestReadyForReview/);
    assert.match(mutationBody, /PR_kwDOExample/);
    assert.match(mutationBody, /\bmerged\b/);
    assert.doesNotMatch(mutationBody, /isMerged/);
  } finally {
    globalThis.fetch = original;
  }
});
