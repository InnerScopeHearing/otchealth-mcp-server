import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

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
  process.env.GITHUB_APP_ID ??= '123456';
  process.env.GITHUB_APP_INSTALLATION_ID ??= '789';
  process.env.GITHUB_APP_PRIVATE_KEY ??= privateKey;
});

test('Git transport mints its fixed scope while REST continues using the independent installation token', async () => {
  const { githubDeveloperGitRead, listPullRequests } = await import('./api-client.js');
  const previousDispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const originalFetch = globalThis.fetch;
  const tokenRequests: Array<{ body: unknown; authorization: string | null }> = [];
  let gitToken = '';
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const authorization = new Headers(init?.headers).get('authorization');
        tokenRequests.push({ body, authorization });
        gitToken = body ? 'fake-scoped-git-token' : gitToken;
        return new Response(JSON.stringify({ token: body ? gitToken : 'fake-rest-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/repos/InnerScopeHearing/otchealth-mcp-server/pulls?state=open&per_page=20')) {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-rest-token');
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected synthetic HTTP request');
    }) as typeof fetch;

    mock.get('https://github.com').intercept({
      path: '/InnerScopeHearing/iheartest.git/info/refs?service=git-upload-pack',
      method: 'GET',
      headers: { authorization: 'Basic ' + Buffer.from('x-access-token:fake-scoped-git-token').toString('base64') },
    }).reply(200, 'synthetic-git-advertisement', {
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
    });

    const result = await githubDeveloperGitRead({
      url: 'https://github.com/InnerScopeHearing/iheartest.git/info/refs?service=git-upload-pack',
      method: 'GET', headers: {}, signal: new AbortController().signal,
    });
    result.body.destroy();
    await listPullRequests('InnerScopeHearing', 'otchealth-mcp-server');

    assert.deepEqual(tokenRequests.map((request) => request.body), [
      { repository_ids: [1_231_250_532], permissions: { contents: 'read' } },
      undefined,
    ]);
    assert.equal(tokenRequests.length, 2);
    assert.equal(tokenRequests.every((request) => request.authorization?.startsWith('Bearer ')), true);
    mock.assertNoPendingInterceptors();
  } finally {
    globalThis.fetch = originalFetch;
    setGlobalDispatcher(previousDispatcher);
    await mock.close();
  }
});

