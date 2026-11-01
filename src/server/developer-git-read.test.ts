import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import type { AuthContext } from '../auth/bearer.js';
import {
  registerDeveloperGitReadRoutes,
  type DeveloperGitReadDependencies,
  type DeveloperGitReadUpstreamRequest,
} from './developer-git-read.js';

const bearer = 'synthetic-developer-bearer';
const authContext = (caller_agent: string): AuthContext => ({
  caller_agent,
  caller_hash: 'a'.repeat(64),
  raw_token: 'synthetic-only',
  connector_surface: true,
  m365_static_auth: false,
});

function makeApp(options: {
  caller?: string | null;
  upstream?: (request: DeveloperGitReadUpstreamRequest) => Promise<{
    statusCode: number;
    contentType?: string;
    body: Readable;
  }>;
} = {}) {
  const app = Fastify({ logger: false });
  const upstreamRequests: DeveloperGitReadUpstreamRequest[] = [];
  const dependencies: DeveloperGitReadDependencies = {
    authenticate: async (request) => {
      assert.equal(request.headers.authorization, `Bearer ${bearer}`);
      return options.caller === null ? null : authContext(options.caller ?? 'developer');
    },
    upstream: async (request) => {
      upstreamRequests.push(request);
      if (options.upstream) return options.upstream(request);
      return {
        statusCode: 200,
        contentType: request.method === 'GET'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-upload-pack-result',
        body: Readable.from([Buffer.from('0000synthetic-git-response\0')]),
      };
    },
  };
  registerDeveloperGitReadRoutes(app, dependencies);
  return { app, upstreamRequests };
}

const route = (repo: string, suffix: string): string => `/developer/git/v1/${repo}/${suffix}`;
const bearerHeader = { authorization: `Bearer ${bearer}` };

test('each Developer app repository is forwarded only to its fixed organization path', async () => {
  const repositories = ['iheartest', 'aware-aural-rehab', 'otchealth-companion', 'innerease',
    'fourvault', 'flatstick', 'plantid-app', 'fictionary'];
  const fixture = makeApp();
  try {
    for (const repo of repositories) {
      const response = await fixture.app.inject({ method: 'GET',
        url: `${route(repo, 'info/refs')}?service=git-upload-pack`, headers: bearerHeader });
      assert.equal(response.statusCode, 200, repo);
      assert.equal(fixture.upstreamRequests.at(-1)?.url,
        `https://github.com/InnerScopeHearing/${repo}.git/info/refs?service=git-upload-pack`);
    }
    assert.equal(fixture.upstreamRequests.length, repositories.length);
  } finally { await fixture.app.close(); }
});

test('each Developer app fetch uses its fixed upload-pack path', async () => {
  for (const repo of ['iheartest', 'aware-aural-rehab', 'otchealth-companion', 'innerease',
    'fourvault', 'flatstick', 'plantid-app', 'fictionary']) {
    const fixture = makeApp();
    try {
      const response = await fixture.app.inject({ method: 'POST', url: route(repo, 'git-upload-pack'),
        headers: { ...bearerHeader, 'content-type': 'application/x-git-upload-pack-request' },
        payload: Buffer.from('synthetic') });
      assert.equal(response.statusCode, 200, repo);
      assert.equal(fixture.upstreamRequests[0]?.url,
        `https://github.com/InnerScopeHearing/${repo}.git/git-upload-pack`);
    } finally { await fixture.app.close(); }
  }
});

test('unauthenticated and non-Developer callers are denied before upstream', async () => {
  const unauthenticated = makeApp({ caller: null });
  try {
    const response = await unauthenticated.app.inject({
      method: 'GET', url: `${route('iheartest', 'info/refs')}?service=git-upload-pack`,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(unauthenticated.upstreamRequests.length, 0);
  } finally { await unauthenticated.app.close(); }

  const otherLane = makeApp({ caller: 'cto' });
  try {
    const response = await otherLane.app.inject({
      method: 'GET',
      url: `${route('iheartest', 'info/refs')}?service=git-upload-pack`,
      headers: bearerHeader,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(otherLane.upstreamRequests.length, 0);
  } finally { await otherLane.app.close(); }
});

test('exact iHeartest discovery and binary upload are forwarded without caller Authorization', async () => {
  const payloadBytes = Buffer.from([0, 255, 1, 2, 0, 128, 10]);
  let receivedUpload = Buffer.alloc(0);
  const fixture = makeApp({
    upstream: async (request) => {
      assert.equal(request.url, request.method === 'GET'
        ? 'https://github.com/InnerScopeHearing/iheartest.git/info/refs?service=git-upload-pack'
        : 'https://github.com/InnerScopeHearing/iheartest.git/git-upload-pack');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      if (request.method === 'POST') {
        assert.ok(request.body);
        const chunks: Buffer[] = [];
        for await (const chunk of request.body!) chunks.push(Buffer.from(chunk));
        receivedUpload = Buffer.concat(chunks);
      }
      return {
        statusCode: 200,
        contentType: request.method === 'GET'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-upload-pack-result',
        body: Readable.from([Buffer.from('0000fixture')]),
      };
    },
  });
  try {
    const discovery = await fixture.app.inject({
      method: 'GET',
      url: `${route('iheartest', 'info/refs')}?service=git-upload-pack`,
      headers: bearerHeader,
    });
    assert.equal(discovery.statusCode, 200);
    assert.equal(discovery.headers['cache-control'], 'no-store');
    assert.equal(discovery.headers['content-type'], 'application/x-git-upload-pack-advertisement');

    const upload = await fixture.app.inject({
      method: 'POST',
      url: route('iheartest', 'git-upload-pack'),
      headers: { ...bearerHeader, 'content-type': 'application/x-git-upload-pack-request' },
      payload: payloadBytes,
    });
    assert.equal(upload.statusCode, 200);
    assert.deepEqual(receivedUpload, payloadBytes);
    assert.equal(upload.headers['cache-control'], 'no-store');
    assert.equal(fixture.upstreamRequests.length, 2);
  } finally { await fixture.app.close(); }
});

test('unknown repo, receive-pack, query manipulation, browser Origin, and wrong MIME are denied', async () => {
  const fixture = makeApp();
  try {
    const unknown = await fixture.app.inject({
      method: 'GET',
      url: `${route('some-other-app', 'info/refs')}?service=git-upload-pack`,
      headers: bearerHeader,
    });
    assert.equal(unknown.statusCode, 404);

    const receivePack = await fixture.app.inject({
      method: 'POST', url: route('iheartest', 'git-receive-pack'),
      headers: { ...bearerHeader, 'content-type': 'application/x-git-receive-pack-request' },
      payload: Buffer.from('synthetic'),
    });
    assert.equal(receivePack.statusCode, 404);

    const badQuery = await fixture.app.inject({
      method: 'GET',
      url: `${route('iheartest', 'info/refs')}?service=git-receive-pack`,
      headers: bearerHeader,
    });
    assert.equal(badQuery.statusCode, 400);

    const origin = await fixture.app.inject({
      method: 'GET',
      url: `${route('iheartest', 'info/refs')}?service=git-upload-pack`,
      headers: { ...bearerHeader, origin: 'https://untrusted.example' },
    });
    assert.equal(origin.statusCode, 403);

    const wrongMime = await fixture.app.inject({
      method: 'POST', url: route('iheartest', 'git-upload-pack'),
      headers: { ...bearerHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0, 255]),
    });
    assert.equal(wrongMime.statusCode, 415);
    assert.equal(fixture.upstreamRequests.length, 0);
  } finally { await fixture.app.close(); }
});

test('redirect-like status and incorrect upstream media type return sanitized gateway errors', async () => {
  for (const upstreamResponse of [
    { statusCode: 302, contentType: 'application/x-git-upload-pack-advertisement' },
    { statusCode: 200, contentType: 'application/json' },
  ]) {
    const fixture = makeApp({
      upstream: async () => ({ ...upstreamResponse, body: Readable.from([Buffer.from('synthetic')]) }),
    });
    try {
      const response = await fixture.app.inject({
        method: 'GET',
        url: `${route('iheartest', 'info/refs')}?service=git-upload-pack`,
        headers: bearerHeader,
      });
      assert.equal(response.statusCode, 502);
      assert.deepEqual(response.json(), { error: 'upstream_error' });
      assert.doesNotMatch(response.body, /synthetic|token|authorization/i);
    } finally { await fixture.app.close(); }
  }
});

test('synthetic upload stream failure returns a sanitized error without relaying the failure text', async () => {
  const fixture = makeApp({
    upstream: async (request) => {
      assert.equal(request.method, 'POST');
      assert.ok(request.body);
      for await (const _chunk of request.body!) { /* consume the synthetic upload stream */ }
      throw new Error('synthetic stream failure with private marker');
    },
  });
  try {
    const response = await fixture.app.inject({
      method: 'POST',
      url: route('iheartest', 'git-upload-pack'),
      headers: { ...bearerHeader, 'content-type': 'application/x-git-upload-pack-request' },
      payload: Buffer.from([0, 255, 1, 128]),
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'upstream_error' });
    assert.doesNotMatch(response.body, /private marker|synthetic stream failure/i);
  } finally { await fixture.app.close(); }
});

test('early upstream rejection aborts the upload and destroys its request stream', async () => {
  let observed: DeveloperGitReadUpstreamRequest | undefined;
  const fixture = makeApp({ upstream: async (request) => {
    observed = request;
    return { statusCode: 403, contentType: 'text/plain', body: Readable.from(['rejected']) };
  } });
  try {
    const response = await fixture.app.inject({ method: 'POST', url: route('iheartest', 'git-upload-pack'),
      headers: { ...bearerHeader, 'content-type': 'application/x-git-upload-pack-request' },
      payload: Buffer.from('fictional upload') });
    assert.equal(response.statusCode, 502);
    assert.ok(observed?.signal.aborted);
    assert.ok(observed?.body?.destroyed);
  } finally { await fixture.app.close(); }
});

test('limits concurrent requests and releases permits after completion', async () => {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
  let count = 0;
  const fixture = makeApp({ upstream: async () => {
    count++;
    if (count === 2) ready();
    await gate;
    return { statusCode: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Readable.from(['0000']) };
  } });
  try {
    const args = { method: 'GET' as const, url: `${route('iheartest', 'info/refs')}?service=git-upload-pack`, headers: bearerHeader };
    const first = fixture.app.inject(args);
    const second = fixture.app.inject(args);
    await Promise.race([bothStarted, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('fixture timeout')), 3000))]);
    const denied = await fixture.app.inject(args);
    assert.equal(denied.statusCode, 429);
    release();
    assert.equal((await first).statusCode, 200);
    assert.equal((await second).statusCode, 200);
    assert.equal((await fixture.app.inject(args)).statusCode, 200);
  } finally { release(); await fixture.app.close(); }
});

test('rejects an oversized declared upload before contacting the upstream', async () => {
  const fixture = makeApp();
  try {
    const response = await fixture.app.inject({ method: 'POST', url: route('iheartest', 'git-upload-pack'),
      headers: { ...bearerHeader, 'content-type': 'application/x-git-upload-pack-request', 'content-length': String(16 * 1024 * 1024 + 1) },
      payload: Buffer.from('small synthetic body') });
    assert.equal(response.statusCode, 413);
    assert.equal(fixture.upstreamRequests.length, 0);
  } finally { await fixture.app.close(); }
});
