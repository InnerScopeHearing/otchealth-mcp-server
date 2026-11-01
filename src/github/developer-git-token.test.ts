import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVELOPER_GIT_REPOSITORIES } from './developer-git-policy.js';
import {
  createDeveloperGitReadTokenProvider,
  DEVELOPER_GIT_REPOSITORY_IDS,
  DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS,
  type DeveloperGitTokenMintRequest,
} from './developer-git-token.js';

const HOUR = 60 * 60 * 1000;

test('route allowlist exactly matches pinned repository IDs', () => {
  assert.deepEqual([...DEVELOPER_GIT_REPOSITORIES].sort(), Object.keys(DEVELOPER_GIT_REPOSITORY_IDS).sort());
  assert.equal(new Set(Object.values(DEVELOPER_GIT_REPOSITORY_IDS)).size, 8);
  assert.equal(DEVELOPER_GIT_REPOSITORY_IDS.iheartest, 1_231_250_532);
});

function fakeInstallationEndpoint(options: {
  token: string;
  expiresAt: () => string;
  delay?: Promise<void>;
  fail?: boolean;
}) {
  const requests: DeveloperGitTokenMintRequest[] = [];
  let nextToken = options.token;
  const mint = async (request: DeveloperGitTokenMintRequest) => {
    requests.push(structuredClone(request));
    await options.delay;
    if (options.fail) throw new Error(`synthetic endpoint rejected ${nextToken}`);
    return { token: nextToken, expires_at: options.expiresAt() };
  };
  return { mint, requests, setToken: (token: string) => { nextToken = token; } };
}

test('each repository gets its own fixed read-only token scope and isolated cache', async () => {
  const requests: DeveloperGitTokenMintRequest[] = [];
  const getToken = createDeveloperGitReadTokenProvider(async (request) => {
    requests.push(structuredClone(request));
    return { token: `fake-${request.repository_ids[0]}`, expires_at: new Date(1_800_000_000_000 + HOUR).toISOString() };
  }, () => 1_800_000_000_000);
  for (const [repo, id] of Object.entries(DEVELOPER_GIT_REPOSITORY_IDS)) {
    assert.equal(await getToken(repo), `fake-${id}`);
    assert.equal(await getToken(repo), `fake-${id}`);
  }
  assert.deepEqual(requests, Object.values(DEVELOPER_GIT_REPOSITORY_IDS).map(id => ({
    repository_ids: [id], permissions: { contents: 'read' },
  })));
  await assert.rejects(() => getToken('medreview'), /invalid_developer_git_repository/);
  assert.equal(requests.length, 8);
});

test('concurrent requests coalesce only within the same repository', async () => {
  let release!: () => void;
  const delay = new Promise<void>((resolve) => { release = resolve; });
  const requests: DeveloperGitTokenMintRequest[] = [];
  const getToken = createDeveloperGitReadTokenProvider(async (request) => {
    requests.push(structuredClone(request));
    await delay;
    return { token: `fake-${request.repository_ids[0]}`, expires_at: new Date(1_800_000_000_000 + HOUR).toISOString() };
  }, () => 1_800_000_000_000);
  const pending = [getToken('iheartest'), getToken('iheartest'), getToken('innerease')];
  release();
  assert.deepEqual(await Promise.all(pending), ['fake-1231250532', 'fake-1231250532', 'fake-1254834356']);
  assert.deepEqual(requests.map(request => request.repository_ids), [[1_231_250_532], [1_254_834_356]]);
});

test('fake installation endpoint receives only the fixed repository and contents:read scope', async () => {
  let now = 1_800_000_000_000;
  const endpoint = fakeInstallationEndpoint({ token: 'fake-git-read-token', expiresAt: () => new Date(now + HOUR).toISOString() });
  const getToken = createDeveloperGitReadTokenProvider(endpoint.mint, () => now);

  assert.equal(await getToken('iheartest'), 'fake-git-read-token');
  assert.deepEqual(endpoint.requests, [{
    repository_ids: [DEVELOPER_GIT_REPOSITORY_IDS.iheartest],
    permissions: { contents: 'read' },
  }]);
  assert.equal(JSON.stringify(endpoint.requests).includes('contents:write'), false);
});

test('route cache reuses a valid token and refreshes at the one-minute expiry boundary', async () => {
  let now = 1_800_000_000_000;
  const endpoint = fakeInstallationEndpoint({ token: 'fake-token-1', expiresAt: () => new Date(now + HOUR).toISOString() });
  const getToken = createDeveloperGitReadTokenProvider(endpoint.mint, () => now);

  assert.equal(await getToken('iheartest'), 'fake-token-1');
  endpoint.setToken('fake-token-2');
  now += HOUR - DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS;
  assert.equal(await getToken('iheartest'), 'fake-token-2');
  assert.equal(endpoint.requests.length, 2);
});

test('route cache is isolated between providers and concurrent mint requests share one token', async () => {
  let now = 1_800_000_000_000;
  let release!: () => void;
  const delay = new Promise<void>((resolve) => { release = resolve; });
  const routeEndpoint = fakeInstallationEndpoint({ token: 'fake-route-token', expiresAt: () => new Date(now + HOUR).toISOString(), delay });
  const routeCache = createDeveloperGitReadTokenProvider(routeEndpoint.mint, () => now);
  const otherRouteEndpoint = fakeInstallationEndpoint({ token: 'fake-other-token', expiresAt: () => new Date(now + HOUR).toISOString() });
  const otherCache = createDeveloperGitReadTokenProvider(otherRouteEndpoint.mint, () => now);

  const first = routeCache('iheartest');
  const second = routeCache('iheartest');
  const isolated = await otherCache('iheartest');
  release();
  assert.deepEqual(await Promise.all([first, second]), ['fake-route-token', 'fake-route-token']);
  assert.equal(isolated, 'fake-other-token');
  assert.equal(routeEndpoint.requests.length, 1);
  assert.equal(otherRouteEndpoint.requests.length, 1);
});

test('failed mint is sanitized and retried only on a later explicit request', async () => {
  let now = 1_800_000_000_000;
  const endpoint = fakeInstallationEndpoint({ token: 'do-not-leak-this', expiresAt: () => new Date(now + HOUR).toISOString(), fail: true });
  const getToken = createDeveloperGitReadTokenProvider(endpoint.mint, () => now);

  await assert.rejects(() => getToken('iheartest'), (error: unknown) => {
    assert.equal((error as Error).message, 'github_developer_git_token_mint_failed');
    assert.equal((error as Error).message.includes('do-not-leak-this'), false);
    return true;
  });
  assert.equal(endpoint.requests.length, 1);
});

test('missing, malformed, or too-near expiry token responses are rejected without caching', async () => {
  let now = 1_800_000_000_000;
  const responses = [
    { token: '', expires_at: new Date(now + HOUR).toISOString() },
    { token: 'fake-token', expires_at: 'not-a-date' },
    { token: 'fake-token', expires_at: new Date(now + DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS).toISOString() },
  ];
  for (const response of responses) {
    const getToken = createDeveloperGitReadTokenProvider(async () => response, () => now);
    await assert.rejects(() => getToken('iheartest'), /github_developer_git_token_response_invalid/);
  }
});
