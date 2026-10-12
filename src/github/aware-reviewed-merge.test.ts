import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

before(() => {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  process.env.GITHUB_APP_ID ??= '123456';
  process.env.GITHUB_APP_INSTALLATION_ID ??= '789';
  process.env.GITHUB_APP_PRIVATE_KEY ??= privateKey;
});

const { mergePullRequest } = await import('./api-client.js');
const owner = 'InnerScopeHearing';
const repo = 'aware-aural-rehab';
const head = '25ee4f3f5f379c1822dec234549f4559778cf8a4';
const required = ['syntax', 'unit', 'a11y', 'gitleaks secret scan', 'Required web release gates', 'trufflehog verified-secret scan'];

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function fixture(options: { draft?: boolean; head?: string; failed?: string; includeChecks?: boolean; readyMismatch?: boolean } = {}) {
  const events: string[] = [];
  let prReads = 0;
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) return response({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    if (url.endsWith('/pulls/165') && init?.method === 'GET') {
      events.push('pr'); prReads++;
      return response({ state: 'open', merged: false, draft: prReads === 1 ? (options.draft ?? true) : (options.readyMismatch ?? false), base: { ref: 'main' }, head: { sha: options.head ?? head }, node_id: 'PR_node' });
    }
    if (url.includes('/check-runs')) {
      events.push('checks');
      return response({ total_count: options.includeChecks === false ? 5 : 6, check_runs: (options.includeChecks === false ? required.slice(0, 5) : required).map((name) => ({ name, head_sha: head, status: 'completed', conclusion: name === options.failed ? 'failure' : 'success' })) });
    }
    if (url.endsWith('/branches/main/protection')) {
      events.push('protection');
      return response({ required_status_checks: { strict: false, contexts: required } });
    }
    if (url.endsWith('/graphql')) {
      events.push('ready');
      return response({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    if (url.endsWith('/pulls/165/merge') && init?.method === 'PUT') {
      events.push('merge');
      return response({ merged: true, sha: 'merge-sha', message: 'merged' });
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  }) as typeof fetch;
  return { events, fetchStub };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const old = globalThis.fetch; globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = old; }
}

test('reviewed AWARE draft promotion is CTO-opt-in, fully gated, reread, then SHA-pinned merge', async () => {
  const f = fixture();
  await withFetch(f.fetchStub, async () => {
    const result = await mergePullRequest(owner, repo, 165, 'squash', undefined, true);
    assert.equal(result.merged, true);
  });
  assert.deepEqual(f.events, ['pr', 'checks', 'protection', 'ready', 'pr', 'merge']);
});

test('reviewed AWARE draft is not promoted without explicit CTO opt-in', async () => {
  const f = fixture();
  await withFetch(f.fetchStub, async () => {
    await assert.rejects(() => mergePullRequest(owner, repo, 165));
  });
  assert.deepEqual(f.events, ['pr']);
});

for (const [label, options] of [
  ['wrong reviewed head', { head: 'stale-sha' }],
  ['failed required check', { failed: 'a11y' }],
  ['missing required check', { includeChecks: false }],
  ['draft state changed or mismatched after promotion', { readyMismatch: true }],
] as const) {
  test(`reviewed merge fails closed on ${label}`, async () => {
    const f = fixture(options);
    await withFetch(f.fetchStub, async () => {
      await assert.rejects(() => mergePullRequest(owner, repo, 165, 'squash', undefined, true));
    });
    assert.equal(f.events.includes('merge'), false);
  });
}

