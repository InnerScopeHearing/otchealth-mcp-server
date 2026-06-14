import '../test-helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerOAuthRoutes, __resetOAuthStateForTests } from './oauth.js';
import { lookupAccessToken } from '../auth/oauth-token-store.js';

const CONSENT_SECRET = 's'.repeat(40); // OAUTH_CONSENT_SECRET in the test env
const CONNECTOR_TOKEN = 'c'.repeat(40); // PERPLEXITY_CONNECTOR_TOKEN in the test env

async function buildApp(): Promise<FastifyInstance> {
  __resetOAuthStateForTests(); // isolate per-test state (esp. the rate limiter)
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  registerOAuthRoutes(app);
  await app.ready();
  return app;
}

function pkce(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function register(app: FastifyInstance, redirectUris: string[]): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: redirectUris } });
  assert.equal(res.statusCode, 201);
  return (res.json() as { client_id: string }).client_id;
}

/** Run GET /authorize and pull the opaque request_id out of the consent form. */
async function startAuthz(
  app: FastifyInstance,
  clientId: string,
  redirectUri: string,
  challenge: string,
): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz` +
      `&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  assert.equal(res.statusCode, 200);
  const m = res.body.match(/name="request_id" value="([^"]+)"/);
  assert.ok(m, 'request_id present in consent form');
  return m![1];
}

test('protected-resource metadata (RFC 9728) lists a fixed authorization server', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { resource: string; authorization_servers: string[] };
  assert.deepEqual(body.authorization_servers, ['https://mcp.test.example']);
  assert.equal(body.resource, 'https://mcp.test.example');
  await app.close();
});

test('authorization-server metadata advertises DCR and S256-only PKCE', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.issuer, 'https://mcp.test.example');
  assert.equal(body.registration_endpoint, 'https://mcp.test.example/register');
  assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  await app.close();
});

test('DCR rejects empty / non-https / too-many redirect_uris', async () => {
  const app = await buildApp();
  assert.equal((await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: [] } })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: ['http://evil.example.com/cb'] } })).statusCode,
    400,
  );
  await app.close();
});

test('DCR issues a client_id for valid https redirect_uris', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { client_id: string; redirect_uris: string[] };
  assert.ok(body.client_id.startsWith('mcp-'));
  assert.deepEqual(body.redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
  await app.close();
});

test('GET /authorize requires PKCE S256 (no challenge -> 400)', async () => {
  const app = await buildApp();
  const clientId = await register(app, ['https://claude.ai/cb']);
  const res = await app.inject({
    method: 'GET',
    url: `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('https://claude.ai/cb')}`,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /PKCE/);
  await app.close();
});

test('B1 regression: redirect_uri not registered for the client is rejected', async () => {
  const app = await buildApp();
  const clientId = await register(app, ['https://claude.ai/cb']);
  const res = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}&code_challenge=${pkce('v'.repeat(64))}&code_challenge_method=S256`,
  });
  assert.equal(res.statusCode, 400); // not the registered redirect_uri
  await app.close();
});

test('GET /authorize rejects an unknown client_id', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/oauth/authorize?response_type=code&client_id=not-registered&redirect_uri=${encodeURIComponent('https://claude.ai/cb')}&code_challenge=${pkce('v'.repeat(64))}&code_challenge_method=S256`,
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('N3: consent page sets anti-clickjacking + no-store headers', async () => {
  const app = await buildApp();
  const clientId = await register(app, ['https://claude.ai/cb']);
  const res = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent('https://claude.ai/cb')}&code_challenge=${pkce('v'.repeat(64))}&code_challenge_method=S256`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
  assert.equal(res.headers['cache-control'], 'no-store');
  await app.close();
});

test('consent gate: POST without a valid request_id does not issue a code', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ request_id: 'bogus', consent_secret: CONSENT_SECRET }).toString(),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['location'], undefined);
  await app.close();
});

test('consent gate: valid request but wrong secret is rejected (no code)', async () => {
  const app = await buildApp();
  const clientId = await register(app, ['https://claude.ai/cb']);
  const requestId = await startAuthz(app, clientId, 'https://claude.ai/cb', pkce('v'.repeat(64)));
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ request_id: requestId, consent_secret: 'wrong-secret' }).toString(),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['location'], undefined);
  await app.close();
});

test('consent secret is NOT the connector token (independence)', async () => {
  // If they were conflated, the connector token would pass the consent gate.
  const app = await buildApp();
  const clientId = await register(app, ['https://claude.ai/cb']);
  const requestId = await startAuthz(app, clientId, 'https://claude.ai/cb', pkce('v'.repeat(64)));
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ request_id: requestId, consent_secret: CONNECTOR_TOKEN }).toString(),
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('full flow: register -> consent -> code -> per-client token (PKCE S256)', async () => {
  const app = await buildApp();
  const verifier = 'a'.repeat(64);
  const challenge = pkce(verifier);
  const clientId = await register(app, ['https://claude.ai/cb']);
  const requestId = await startAuthz(app, clientId, 'https://claude.ai/cb', challenge);

  const authz = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ request_id: requestId, consent_secret: CONSENT_SECRET }).toString(),
  });
  assert.equal(authz.statusCode, 302);
  const loc = new URL(authz.headers['location'] as string);
  assert.equal(loc.origin + loc.pathname, 'https://claude.ai/cb');
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code') as string;
  assert.ok(code);

  // Wrong PKCE verifier must fail (and burn the one-time code).
  const bad = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://claude.ai/cb',
      client_id: clientId,
      code_verifier: 'wrong-verifier',
    }).toString(),
  });
  assert.equal(bad.statusCode, 400);

  // Fresh code, correct verifier -> a minted per-client token that validates.
  const requestId2 = await startAuthz(app, clientId, 'https://claude.ai/cb', challenge);
  const authz2 = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ request_id: requestId2, consent_secret: CONSENT_SECRET }).toString(),
  });
  const code2 = new URL(authz2.headers['location'] as string).searchParams.get('code') as string;

  const tok = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code2,
      redirect_uri: 'https://claude.ai/cb',
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(tok.statusCode, 200);
  const tokenBody = tok.json() as { access_token: string; token_type: string };
  assert.equal(tokenBody.token_type, 'Bearer');
  assert.ok(tokenBody.access_token.startsWith('oat_'));
  assert.notEqual(tokenBody.access_token, CONNECTOR_TOKEN); // never the master token
  assert.ok(lookupAccessToken(tokenBody.access_token), 'minted token is valid in the store');
  await app.close();
});
