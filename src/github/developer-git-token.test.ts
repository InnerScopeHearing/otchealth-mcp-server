import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVELOPER_GIT_REPOSITORIES } from './developer-git-policy.js';
import {
  createDeveloperGitReadTokenProvider,
  DEVELOPER_GIT_REPOSITORY_ID,
  DEVELOPER_GIT_TOKEN_REPOSITORY_NAME,
  DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS,
  type DeveloperGitTokenMintRequest,
} from './developer-git-token.js';

const HOUR = 60 * 60 * 1000;

test('single allowed route repository is exactly the one bound into the scoped token', () => {
  assert.deepEqual([...DEVELOPER_GIT_REPOSITORIES], [DEVELOPER_GIT_TOKEN_REPOSITORY_NAME],
    'adding a route repository must intentionally redesign this single-repository token scope');
  assert.equal(DEVELOPER_GIT_TOKEN_REPOSITORY_NAME, 'iheartest');
  assert.equal(DEVELOPER_GIT_REPOSITORY_ID, 1_231_250_532);
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

test('fake installation endpoint receives only the fixed repository and contents:read scope', async () => {
  let now = 1_800_000_000_000;
  const endpoint = fakeInstallationEndpoint({ token: 'fake-git-read-token', expiresAt: () => new Date(now + HOUR).toISOString() });
  const getToken = createDeveloperGitReadTokenProvider(endpoint.mint, () => now);

  assert.equal(await getToken(), 'fake-git-read-token');
  assert.deepEqual(endpoint.requests, [{
    repository_ids: [DEVELOPER_GIT_REPOSITORY_ID],
    permissions: { contents: 'read' },
  }]);
  assert.equal(JSON.stringify(endpoint.requests).includes('contents:write'), false);
});

test('route cache reuses a valid token and refreshes at the one-minute expiry boundary', async () => {
  let now = 1_800_000_000_000;
  const endpoint = fakeInstallationEndpoint({ token: 'fake-token-1', expiresAt: () => new Date(now + HOUR).toISOString() });
  const getToken = createDeveloperGitReadTokenProvider(endpoint.mint, () => now);

  assert.equal(await getToken(), 'fake-token-1');
  endpoint.setToken('fake-token-2');
  now += HOUR - DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS;
  assert.equal(await getToken(), 'fake-token-2');
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

  const first = routeCache();
  const second = routeCache();
  const isolated = await otherCache();
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

  await assert.rejects(getToken, (error: unknown) => {
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
    await assert.rejects(getToken, /github_developer_git_token_response_invalid/);
  }
});
