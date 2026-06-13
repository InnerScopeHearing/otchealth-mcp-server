import '../test-helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerOAuthRoutes } from './oauth.js';

// In the test env (test-helpers/env.ts), OAUTH_CONSENT_SECRET is unset, so the
// consent gate falls back to ADMIN_REVOKE_TOKEN = 'x'.repeat(40).
const CONSENT_SECRET = 'x'.repeat(40);
const CONNECTOR_TOKEN = 'x'.repeat(40); // PERPLEXITY_CONNECTOR_TOKEN in the test env

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // The token + consent endpoints accept form-urlencoded bodies (as in server/index.ts).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );
  registerOAuthRoutes(app);
  await app.ready();
  return app;
}

function pkce(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

test('protected-resource metadata (RFC 9728) lists an authorization server', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { resource: string; authorization_servers: string[] };
  assert.ok(Array.isArray(body.authorization_servers) && body.authorization_servers.length >= 1);
  assert.ok(typeof body.resource === 'string' && body.resource.startsWith('http'));
  await app.close();
});

test('authorization-server metadata advertises the registration endpoint', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.ok(typeof body.registration_endpoint === 'string');
  assert.ok(typeof body.authorization_endpoint === 'string');
  assert.ok(typeof body.token_endpoint === 'string');
  assert.deepEqual(body.code_challenge_methods_supported, ['S256', 'plain']);
  await app.close();
});

test('DCR rejects empty or non-https redirect_uris', async () => {
  const app = await buildApp();
  const empty = await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: [] } });
  assert.equal(empty.statusCode, 400);
  const bad = await app.inject({
    method: 'POST',
    url: '/register',
    payload: { redirect_uris: ['http://evil.example.com/cb'] },
  });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test('DCR issues a client_id for valid https redirect_uris', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/register',
    payload: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { client_id: string; redirect_uris: string[] };
  assert.ok(body.client_id.startsWith('mcp-'));
  assert.deepEqual(body.redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
  await app.close();
});

test('GET /oauth/authorize renders the consent screen for a registered client', async () => {
  const app = await buildApp();
  const reg = await app.inject({
    method: 'POST',
    url: '/register',
    payload: { redirect_uris: ['https://claude.ai/cb'] },
  });
  const clientId = (reg.json() as { client_id: string }).client_id;
  const res = await app.inject({
    method: 'GET',
    url: `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('https://claude.ai/cb')}&state=abc`,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /consent_secret/);
  await app.close();
});

test('GET /oauth/authorize rejects an unknown client_id', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/oauth/authorize?response_type=code&client_id=not-registered&redirect_uri=${encodeURIComponent('https://claude.ai/cb')}`,
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('consent gate: POST /oauth/authorize without the secret does NOT issue a code', async () => {
  const app = await buildApp();
  const reg = await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: ['https://claude.ai/cb'] } });
  const clientId = (reg.json() as { client_id: string }).client_id;
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/cb',
    }).toString(),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['location'], undefined);
  await app.close();
});

test('consent gate: wrong secret is rejected', async () => {
  const app = await buildApp();
  const reg = await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: ['https://claude.ai/cb'] } });
  const clientId = (reg.json() as { client_id: string }).client_id;
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/cb',
      consent_secret: 'wrong-secret',
    }).toString(),
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('full flow: register -> consent -> code -> token (with PKCE)', async () => {
  const app = await buildApp();
  const verifier = 'a'.repeat(64);
  const challenge = pkce(verifier);

  const reg = await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: ['https://claude.ai/cb'] } });
  const clientId = (reg.json() as { client_id: string }).client_id;

  // Consent with the correct secret + PKCE challenge -> 302 redirect carrying the code.
  const authz = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/cb',
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      consent_secret: CONSENT_SECRET,
    }).toString(),
  });
  assert.equal(authz.statusCode, 302);
  const location = authz.headers['location'] as string;
  const code = new URL(location).searchParams.get('code');
  assert.ok(code, 'authorization code present in redirect');
  assert.equal(new URL(location).searchParams.get('state'), 'xyz');

  // Wrong verifier must fail PKCE.
  const badTok = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: 'https://claude.ai/cb',
      client_id: clientId,
      code_verifier: 'wrong-verifier',
    }).toString(),
  });
  assert.equal(badTok.statusCode, 400);

  // The code was single-use + consumed by the failed attempt; re-run the consent
  // to get a fresh code, then exchange with the correct verifier.
  const authz2 = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      consent_secret: CONSENT_SECRET,
    }).toString(),
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
  assert.equal(tokenBody.access_token, CONNECTOR_TOKEN);
  await app.close();
});
