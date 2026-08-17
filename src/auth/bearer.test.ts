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

// ── auth_rejected diagnosability (2026-08-17) ────────────────────────────────────────────────────
// The reject log used to carry only route + ip, so a background internet scanner and a real fleet
// client sending a stale credential produced byte-identical lines. That ambiguity cost an hour of
// log archaeology during the Hyperagent connection outage. These pin the three fields that resolve
// it -- and, more importantly, pin that adding them did NOT put a credential into a log.
//
// Asserting on authRejectionLogFields' return value rather than on pino's output is deliberate:
// pino writes to fd 1 via sonic-boom, so a `process.stdout.write` spy observes nothing and a test
// built on one passes vacuously. The payload is the part this module actually controls.
function fakeRequest(headers: Record<string, string>, url = '/mcp'): never {
  return { headers, url, ip: '203.0.113.9', routeOptions: { url } } as never;
}

test('auth_rejected: no credential at all is classified no_credential and carries NO caller_hash', async () => {
  const { authRejectionLogFields } = await import('./bearer.js');
  const f = authRejectionLogFields(fakeRequest({ 'user-agent': 'SomeScanner/1.0' }));
  assert.equal(f.reason, 'no_credential');
  assert.equal(f.client, 'SomeScanner/1.0');
  // Absence is load-bearing: "caller_hash present" must mean "a credential was actually sent", so a
  // reader can separate benign unauthenticated probes from real misconfigurations at a glance.
  assert.equal('caller_hash' in f, false, 'no credential was sent, so none should be hashed');
});

test('auth_rejected: an unrecognized credential is classified unrecognized_credential and hashed', async () => {
  const { authRejectionLogFields } = await import('./bearer.js');
  const f = authRejectionLogFields(
    fakeRequest({ authorization: 'Bearer ' + 'z'.repeat(40), 'user-agent': 'Hyperagent/2.1' }),
  );
  assert.equal(f.reason, 'unrecognized_credential');
  assert.equal(f.client, 'Hyperagent/2.1');
  assert.match(String(f.caller_hash), /^[0-9a-f]{64}$/, 'expected a SHA256 hex digest');
});

test('auth_rejected: a missing User-Agent degrades to null rather than throwing', async () => {
  const { authRejectionLogFields } = await import('./bearer.js');
  const f = authRejectionLogFields(fakeRequest({}));
  assert.equal(f.client, null);
  assert.equal(f.reason, 'no_credential');
});

test('SAFETY-CRITICAL: the rejected credential VALUE never appears anywhere in the logged payload', async () => {
  const { authRejectionLogFields } = await import('./bearer.js');
  const secret = 'q7' + 'w'.repeat(38);
  const f = authRejectionLogFields(fakeRequest({ authorization: `Bearer ${secret}`, 'user-agent': 'x' }));
  // Assert over the SERIALIZED payload, not one field: a leak could hide in any key, including one
  // added later. This is the regression that matters -- the log runs on an unauthenticated path.
  assert.equal(JSON.stringify(f).includes(secret), false, 'raw credential leaked into the log payload');
  const { createHash } = await import('node:crypto');
  assert.equal(f.caller_hash, createHash('sha256').update(secret).digest('hex'));
});
