import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

before(() => {
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
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_INSTALLATION_ID = '789';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
});

test('full and write clients refuse GitHub redirects without following a renamed destination', async () => {
  const { createBranch } = await import('./write-client.js');
  const { labelCreate } = await import('./full-client.js');
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  let mutation = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    if (url.endsWith('/access_tokens')) {
      return new Response(JSON.stringify({
        token: `ghs_redirect_test_${seen.length}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }

    mutation += 1;
    if (mutation === 1) {
      return new Response('', {
        status: 307,
        headers: { location: 'https://api.github.com/repos/InnerScopeHearing/phi-renamed/git/refs' },
      });
    }
    const followed = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(followed, 'redirected', { value: true });
    return followed;
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => createBranch('InnerScopeHearing', 'old-name', 'codex/test', 'a'.repeat(40)),
      (error: unknown) => (error as { code?: string }).code === 'github_redirect_refused',
    );
    await assert.rejects(
      () => labelCreate('InnerScopeHearing', 'old-name', 'test', 'ffffff'),
      (error: unknown) => (error as { code?: string }).code === 'github_redirect_refused',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seen.length, 4, 'each client should mint once and issue one mutation without a follow-up');
  for (const request of seen) {
    assert.equal(new URL(request.url).origin, 'https://api.github.com');
    assert.equal(request.redirect, 'error');
  }
});

test('api, write, and full clients reject traversal inputs before token mint or upstream fetch', async () => {
  const { getFileContents } = await import('./api-client.js');
  const { createOrUpdateFile } = await import('./write-client.js');
  const {
    branchGet,
    contentsDeleteFile,
    labelDelete,
    refDelete,
    refUpdate,
    workflowGet,
    repoGet,
  } = await import('./full-client.js');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('unsafe path reached the network');
  }) as typeof fetch;

  const invalid = ['.', '..', '%2e%2e', '.%2e', '%2e.', '%252e%252e', '%2f', '%252f', '%5c', '%255c', '?outside', '#outside'];
  try {
    for (const value of invalid) {
      const checks: Array<() => Promise<unknown>> = [
        () => getFileContents('InnerScopeHearing', 'safe-repo', `src/${value}/file.ts`),
        () => createOrUpdateFile({
          owner: 'InnerScopeHearing', repo: 'safe-repo', path: `src/${value}/file.ts`,
          message: 'synthetic', content: 'export {};', branch: 'feature/safe',
        }),
        () => contentsDeleteFile({
          owner: 'InnerScopeHearing', repo: 'safe-repo', path: value,
          message: 'synthetic', sha: 'a'.repeat(40),
        }),
        () => refDelete('InnerScopeHearing', 'safe-repo', value),
        () => refUpdate('InnerScopeHearing', 'safe-repo', value, 'a'.repeat(40)),
        () => labelDelete('InnerScopeHearing', 'safe-repo', value),
        () => branchGet('InnerScopeHearing', 'safe-repo', value),
        () => workflowGet('InnerScopeHearing', 'safe-repo', value),
      ];
      for (const check of checks) {
        await assert.rejects(
          check,
          (error: unknown) => (error as { code?: string }).code === 'github_invalid_path',
          value,
        );
      }
    }

    for (const value of ['InnerScopeHearing/external', '%2fexternal', '%252fexternal', 'safe%5cexternal', 'safe%255cexternal']) {
      const checks: Array<() => Promise<unknown>> = [
        () => getFileContents(value, 'safe-repo', 'src/index.ts'),
        () => createOrUpdateFile({
          owner: 'InnerScopeHearing', repo: value, path: 'src/index.ts',
          message: 'synthetic', content: 'export {};', branch: 'feature/safe',
        }),
        () => repoGet(value, 'safe-repo'),
      ];
      for (const check of checks) {
        await assert.rejects(
          check,
          (error: unknown) => (error as { code?: string }).code === 'github_invalid_path',
          value,
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test('hierarchical feature branches remain usable at every file, commit, branch, ref, and workflow route', async () => {
  const { getFileContents, pushFiles } = await import('./api-client.js');
  const {
    branchGet,
    branchGetProtection,
    commitCompare,
    commitGet,
    labelDelete,
    refDelete,
    refUpdate,
    workflowGet,
  } = await import('./full-client.js');
  const originalFetch = globalThis.fetch;
  const seen: Array<{ method: string; url: URL }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    seen.push({ method, url });
    if (url.pathname.endsWith('/access_tokens')) {
      return new Response(JSON.stringify({
        token: `ghs_path_test_${seen.length}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.includes('/contents/')) {
      return new Response(JSON.stringify({ sha: 'file-sha', content: Buffer.from('ok').toString('base64') }), { status: 200 });
    }
    if (url.pathname.includes('/git/ref/heads/')) {
      return new Response(JSON.stringify({ object: { sha: 'head-sha' } }), { status: 200 });
    }
    if (url.pathname.endsWith('/git/commits/head-sha')) {
      return new Response(JSON.stringify({ tree: { sha: 'base-tree' } }), { status: 200 });
    }
    if (url.pathname.endsWith('/git/blobs')) {
      return new Response(JSON.stringify({ sha: 'blob-sha' }), { status: 201 });
    }
    if (url.pathname.endsWith('/git/trees')) {
      return new Response(JSON.stringify({ sha: 'tree-sha' }), { status: 201 });
    }
    if (url.pathname.endsWith('/git/commits')) {
      return new Response(JSON.stringify({ sha: 'commit-sha' }), { status: 201 });
    }
    return method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await getFileContents('InnerScopeHearing', 'safe-repo', 'src/index.ts', 'feature/operator-access');
    await pushFiles(
      'InnerScopeHearing',
      'safe-repo',
      'feature/operator-access',
      [{ path: 'src/index.ts', content: 'export {};' }],
      'synthetic path compatibility',
    );
    await commitGet('InnerScopeHearing', 'safe-repo', 'feature/operator-access');
    await commitCompare('InnerScopeHearing', 'safe-repo', 'release/1', 'feature/operator-access');
    await branchGet('InnerScopeHearing', 'safe-repo', 'feature/operator-access');
    await branchGetProtection('InnerScopeHearing', 'safe-repo', 'feature/operator-access');
    await refUpdate('InnerScopeHearing', 'safe-repo', 'heads/feature/operator-access', 'a'.repeat(40));
    await refDelete('InnerScopeHearing', 'safe-repo', 'heads/feature/operator-access');
    await workflowGet('InnerScopeHearing', 'safe-repo', '.github/workflows/ci.yml');
    await labelDelete('InnerScopeHearing', 'safe-repo', 'type/bug');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const routes = seen.map(({ url }) => `${url.pathname}${url.search}`);
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/contents/src/index.ts?ref=feature%2Foperator-access'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/git/ref/heads/feature%2Foperator-access'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/git/refs/heads/feature%2Foperator-access'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/commits/feature%2Foperator-access'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/compare/release%2F1...feature%2Foperator-access'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/branches/feature%2Foperator-access'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/branches/feature%2Foperator-access/protection'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/git/refs/heads/feature/operator-access'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/actions/workflows/.github%2Fworkflows%2Fci.yml'));
  assert.ok(routes.includes('/repos/InnerScopeHearing/safe-repo/labels/type%2Fbug'));
});
