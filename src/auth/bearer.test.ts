import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// bearer.ts calls loadEnv() at module top level (`const env = loadEnv();`), and it imports oauth.ts
// (which does the same), so both must be imported AFTER the required env vars are set -- dynamic
// import inside each test, run after before() has populated process.env. Mirrors
// catalog-warm.test.ts's / oauth.test.ts's pattern for the same underlying reason.
//
// RFC 9728 (Phase 5/6 connector-ring closure, 2026-07-15, layer 4): a 401 from requireConnectorAuth
// was missing the WWW-Authenticate header spec-compliant MCP clients use to discover the protected-
// resource metadata endpoint. This exercises the REAL Fastify route handler end to end (via
// app.inject, no network) rather than a pure predicate, since the behavior under test is "does the
// reply object carry the right header," which only exists at the HTTP-reply layer.

const CONNECTOR_TOKEN = 'a'.repeat(32);

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: CONNECTOR_TOKEN,
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

test('SAFETY-CRITICAL: a 401 (missing/invalid bearer) carries a WWW-Authenticate header naming the protected-resource metadata URL', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth } = await import('./bearer.js');

  const app = Fastify();
  app.post('/mcp', async (request, reply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    return reply.send({ ok: true });
  });

  const res = await app.inject({ method: 'POST', url: '/mcp' });
  assert.equal(res.statusCode, 401);
  const header = res.headers['www-authenticate'];
  assert.ok(header, 'expected a WWW-Authenticate header on the 401 response');
  assert.match(
    String(header),
    /^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"$/,
  );

  await app.close();
});

test('an invalid (wrong) bearer token also gets the WWW-Authenticate header on its 401', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth } = await import('./bearer.js');

  const app = Fastify();
  app.post('/mcp', async (request, reply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    return reply.send({ ok: true });
  });

  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: 'Bearer not-the-right-token' },
  });
  assert.equal(res.statusCode, 401);
  assert.ok(res.headers['www-authenticate']);

  await app.close();
});

test('a VALID bearer token succeeds and carries no WWW-Authenticate header (header is failure-path only)', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth } = await import('./bearer.js');

  const app = Fastify();
  app.post('/mcp', async (request, reply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    return reply.send({ ok: true });
  });

  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${CONNECTOR_TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['www-authenticate'], undefined);

  await app.close();
});
