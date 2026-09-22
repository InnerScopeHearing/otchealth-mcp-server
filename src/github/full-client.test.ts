import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

// full-client loads its configuration at import time, so establish its entirely
// synthetic test environment before dynamically importing the module.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
process.env.GITHUB_APP_ID ??= '123456';
process.env.GITHUB_APP_INSTALLATION_ID ??= '789';
process.env.GITHUB_APP_PRIVATE_KEY ??= privateKey;
process.env.CIO_SITE_ID ??= 'test';
process.env.CIO_TRACK_KEY ??= 'test';
process.env.CIO_APP_API_BEARER ??= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);

const { GitHubFullError, prMarkReadyForReview } = await import('./full-client.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('prMarkReadyForReview uses only its fixed GraphQL mutation after a matching draft/head precondition', async () => {
  const seen: Array<{ url: string; method: string; body?: unknown }> = [];
  await withStubbedFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) {
      return json({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (url.endsWith('/repos/InnerScopeHearing/otchealth-mcp-server/pulls/434')) {
      return json({ number: 434, draft: true, node_id: 'PR_node_434', html_url: 'https://example.test/pr/434', head: { sha: 'abcdef0123456789' } });
    }
    if (url === 'https://api.github.com/graphql') {
      return json({ data: { markPullRequestReadyForReview: { pullRequest: { number: 434, isDraft: false, headRefOid: 'abcdef0123456789', url: 'https://example.test/pr/434' } } } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch, async () => {
    const result = await prMarkReadyForReview({
      owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', pullNumber: 434, expectedHeadSha: 'abcdef0123456789',
    });
    assert.deepEqual(result, { number: 434, alreadyReady: false, headSha: 'abcdef0123456789', url: 'https://example.test/pr/434' });
  });

  const graphql = seen.find((request) => request.url === 'https://api.github.com/graphql');
  assert.ok(graphql, 'expected the fixed GitHub GraphQL endpoint');
  assert.equal(graphql.method, 'POST');
  assert.deepEqual(graphql.body, {
    query: `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {\n      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n        pullRequest { number isDraft headRefOid url }\n      }\n    }`,
    variables: { pullRequestId: 'PR_node_434' },
  });
  assert.equal(seen.filter((request) => request.url === 'https://api.github.com/graphql').length, 1, 'mutation must not retry');
});

test('prMarkReadyForReview refuses a stale head before any GraphQL mutation', async () => {
  const urls: string[] = [];
  await withStubbedFetch((async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/repos/InnerScopeHearing/otchealth-mcp-server/pulls/434')) {
      return json({ number: 434, draft: true, node_id: 'PR_node_434', head: { sha: 'current-head' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch, async () => {
    await assert.rejects(
      () => prMarkReadyForReview({ owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', pullNumber: 434, expectedHeadSha: 'stale-head' }),
      (error: unknown) => error instanceof GitHubFullError && error.code === 'github_pr_head_sha_mismatch',
    );
  });
  assert.equal(urls.includes('https://api.github.com/graphql'), false, 'stale precondition must make no mutation request');
});

test('prMarkReadyForReview is a no-op for a PR that is already ready', async () => {
  const urls: string[] = [];
  await withStubbedFetch((async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/repos/InnerScopeHearing/otchealth-mcp-server/pulls/434')) {
      return json({ number: 434, draft: false, node_id: 'PR_node_434', html_url: 'https://example.test/pr/434', head: { sha: 'abcdef0123456789' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch, async () => {
    const result = await prMarkReadyForReview({
      owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', pullNumber: 434, expectedHeadSha: 'abcdef0123456789',
    });
    assert.deepEqual(result, { number: 434, alreadyReady: true, headSha: 'abcdef0123456789', url: 'https://example.test/pr/434' });
  });
  assert.equal(urls.includes('https://api.github.com/graphql'), false, 'already-ready transition must make no mutation request');
});
