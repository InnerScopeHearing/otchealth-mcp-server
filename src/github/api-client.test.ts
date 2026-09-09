import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

// Minimum env EnvSchema requires with no default (mirrors netlify/api-client.test.ts,
// graph/api-client.test.ts, tools/registry.lane-curation.test.ts).
before(() => {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
  // A real (test-only) RSA keypair so mintJwt()'s RSA-SHA256 signature succeeds without touching
  // any real GitHub App credential.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  process.env.GITHUB_APP_ID ??= '123456';
  process.env.GITHUB_APP_INSTALLATION_ID ??= '789';
  process.env.GITHUB_APP_PRIVATE_KEY ??= privateKey;
});

const { getPullRequest, isGitHubPullRequestNumber, listWorkflowRuns, mergePullRequest, parseGitHubRepositoryFullName } = await import('./api-client.js');

// This repo's ESM build does not allow node:test's mock.method() to override another module's
// live named export, but globalThis.fetch is a genuine global -- direct reassignment works fine.
// Mirrors src/util/fetch-budget.test.ts's own withStubbedFetch helper.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** A fetch stub that answers the GitHub App token mint + records every actions/runs GET URL. */
function githubStub(capturedUrls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) {
      return new Response(
        JSON.stringify({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/actions/runs')) {
      capturedUrls.push(url);
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

test('listWorkflowRuns: no filters -- preserves the pre-fix default (per_page=20, no other params)', async () => {
  const urls: string[] = [];
  await withStubbedFetch(githubStub(urls), async () => {
    await listWorkflowRuns('InnerScopeHearing', 'otchealth-mcp-server');
  });
  const runsCall = urls.find((u) => u.includes('/actions/runs'));
  assert.ok(runsCall, 'expected a call to the actions/runs endpoint');
  const q = new URL(runsCall!).searchParams;
  assert.equal(q.get('per_page'), '20');
  assert.equal(q.get('status'), null);
  assert.equal(q.get('page'), null);
});

test('listWorkflowRuns: status="waiting" reaches the real upstream GitHub request', async () => {
  const urls: string[] = [];
  await withStubbedFetch(githubStub(urls), async () => {
    await listWorkflowRuns('InnerScopeHearing', 'otchealth-mcp-server', { status: 'waiting' });
  });
  const runsCall = urls.find((u) => u.includes('/actions/runs'));
  assert.ok(runsCall);
  assert.equal(new URL(runsCall!).searchParams.get('status'), 'waiting');
});

test('listWorkflowRuns: every other filter (branch/event/actor/created/exclude_pull_requests/check_suite_id/head_sha/page) reaches the upstream request', async () => {
  const urls: string[] = [];
  await withStubbedFetch(githubStub(urls), async () => {
    await listWorkflowRuns('InnerScopeHearing', 'otchealth-mcp-server', {
      branch: 'claude/gh-workflow-runs-filter',
      event: 'workflow_dispatch',
      actor: 'GBGolfMatt',
      created: '>=2026-08-01',
      exclude_pull_requests: true,
      check_suite_id: 4242,
      head_sha: 'deadbeefcafefeed',
      per_page: 5,
      page: 2,
    });
  });
  const runsCall = urls.find((u) => u.includes('/actions/runs'));
  assert.ok(runsCall);
  const q = new URL(runsCall!).searchParams;
  assert.equal(q.get('branch'), 'claude/gh-workflow-runs-filter');
  assert.equal(q.get('event'), 'workflow_dispatch');
  assert.equal(q.get('actor'), 'GBGolfMatt');
  assert.equal(q.get('created'), '>=2026-08-01');
  assert.equal(q.get('exclude_pull_requests'), 'true');
  assert.equal(q.get('check_suite_id'), '4242');
  assert.equal(q.get('head_sha'), 'deadbeefcafefeed');
  assert.equal(q.get('per_page'), '5');
  assert.equal(q.get('page'), '2');
});

test('GitHub repository selectors reject authority and path injection before an API path is built', () => {
  assert.deepEqual(parseGitHubRepositoryFullName('InnerScopeHearing/otchealth-mcp-server'), {
    owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', fullName: 'InnerScopeHearing/otchealth-mcp-server',
  });
  for (const invalid of ['https://evil.example/repo', 'owner/repo/extra', 'owner//repo', 'owner/repo?x=1', 'owner/repo\\path']) {
    assert.equal(parseGitHubRepositoryFullName(invalid), null, invalid);
  }
  assert.equal(isGitHubPullRequestNumber(42), true);
  assert.equal(isGitHubPullRequestNumber(0), false);
  assert.equal(isGitHubPullRequestNumber(1.5), false);
  assert.equal(isGitHubPullRequestNumber('42'), false);
});

test('GitHub API calls keep the fixed API origin and refuse redirects', async () => {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  await withStubbedFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
    }
    return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
  }) as typeof fetch, async () => {
    await listWorkflowRuns('InnerScopeHearing', 'otchealth-mcp-server');
  });
  assert.ok(seen.length > 0);
  for (const request of seen) {
    assert.equal(new URL(request.url).origin, 'https://api.github.com');
    assert.equal(request.redirect, 'error');
  }
});

test('GitHub API calls reject a redirect response without making a follow-up request', async () => {
  const urls: string[] = [];
  await withStubbedFetch((async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response('', { status: 302, headers: { location: 'https://unexpected.example/' } });
  }) as typeof fetch, async () => {
    await assert.rejects(
      () => listWorkflowRuns('InnerScopeHearing', 'otchealth-mcp-server'),
      (error: unknown) => (error as { code?: string }).code === 'github_redirect_refused',
    );
  });
  assert.equal(urls.length, 1, 'a redirect response must not result in a second request');
  assert.equal(new URL(urls[0]!).origin, 'https://api.github.com');
});

test('GitHub pull-request routes reject malformed numbers before credentials or network access', async () => {
  let calls = 0;
  await withStubbedFetch((async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch, async () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, '42', null]) {
      await assert.rejects(
        () => getPullRequest('InnerScopeHearing', 'otchealth-mcp-server', invalid),
        (error: unknown) => (error as { code?: string }).code === 'github_invalid_pull_request_number',
      );
      await assert.rejects(
        () => mergePullRequest('InnerScopeHearing', 'otchealth-mcp-server', invalid),
        (error: unknown) => (error as { code?: string }).code === 'github_invalid_pull_request_number',
      );
    }
  });
  assert.equal(calls, 0);
});

test('GitHub pull-request routes use canonical numeric path segments', async () => {
  const seen: string[] = [];
  await withStubbedFetch((async (input: RequestInfo | URL) => {
    seen.push(String(input));
    if (String(input).endsWith('/merge')) return new Response(JSON.stringify({ merged: false, sha: '', message: 'not merged' }), { status: 200 });
    return new Response(JSON.stringify({ number: 42 }), { status: 200 });
  }) as typeof fetch, async () => {
    await getPullRequest('InnerScopeHearing', 'otchealth-mcp-server', 42);
    await mergePullRequest('InnerScopeHearing', 'otchealth-mcp-server', 42);
  });
  assert.deepEqual(seen.map((url) => new URL(url).pathname), [
    '/repos/InnerScopeHearing/otchealth-mcp-server/pulls/42',
    '/repos/InnerScopeHearing/otchealth-mcp-server/pulls/42/merge',
  ]);
});
