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
const M365_CTO_TOKEN = 'm'.repeat(40);

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: CONNECTOR_TOKEN,
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    // Set before the FIRST dynamic import of bearer.js in this file, since bearer.ts's
    // `m365StaticAgentTokens()` reads `env.M365_CTO_MCP_TOKEN` via the module-level `loadEnv()`
    // call, which only ever runs once per process.
    M365_CTO_MCP_TOKEN: M365_CTO_TOKEN,
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

// ── extractBearer: linear-time parsing (CodeQL js/polynomial-redos, high) ────────────────────────
// The old /^Bearer\s+(.+)$/i let `\s+` and `(.+)` both match a space, so a header of "Bearer " plus
// many spaces forced the engine through every split point. This path is UNAUTHENTICATED and the
// header is fully attacker-controlled, so the parse must be linear. Exercised through
// authRejectionLogFields because extractBearer is module-private.
function req(authorization?: string): never {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return { headers, url: '/mcp', ip: '203.0.113.9', routeOptions: { url: '/mcp' } } as never;
}

test('extractBearer parity: the scheme is case-insensitive, whitespace-separated, and trims', async () => {
  const { authRejectionLogFields } = await import('./bearer.js');
  const hash = (h: string) => authRejectionLogFields(req(h)).caller_hash;

  // The same token reached by different spellings must hash identically -- that proves the rewrite
  // preserved the old semantics rather than merely being faster.
  const canonical = hash('Bearer tok123');
  assert.equal(hash('bearer tok123'), canonical, 'scheme should be case-insensitive');
  assert.equal(hash('BEARER \t  tok123  '), canonical, 'multiple whitespace + trailing trim');
  // "BearerTok123" with no separator is not a bearer credential.
  assert.equal(
    'caller_hash' in authRejectionLogFields(req('BearerTok123')),
    false,
    'scheme must be followed by whitespace',
  );
});

test('SECURITY: a pathological all-whitespace bearer header parses in linear time', async () => {
  const { authRejectionLogFields } = await import('./bearer.js');
  // This is the input class that blows up under the old polynomial regex.
  const evil = 'Bearer ' + ' '.repeat(200_000);
  const started = process.hrtime.bigint();
  const f = authRejectionLogFields(req(evil));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // All whitespace after the scheme trims to empty, i.e. no credential was really presented.
  assert.equal(f.reason, 'no_credential');
  // Generous bound: the assertion is "not catastrophic", not a microbenchmark, so it stays stable
  // on a loaded CI box while still failing loudly if quadratic behaviour ever returns.
  assert.ok(ms < 1000, `expected linear-time parse, took ${ms.toFixed(1)}ms`);
});

// ── M365 static per-lane token: header path (2026-08-18, HIGH security finding) ──────────────────
// build-agents.mjs currently ships this token as a `?m365_dev_token=<token>` query parameter on
// spec.url, because the M365 declarative-agent RemoteMCPServer runtime (schema v2.4) genuinely has
// no way to deliver a static, non-interactive credential over a header: `auth.type: "None"` sends
// no header of any kind (confirmed: no headers field exists on the MCP server spec object, and
// Microsoft's own docs at
// https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication and
// https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-api-key
// state explicitly, twice, that MCP plugins do not support API-key authentication --
// `ApiKeyPluginVault` is a valid enum value in the schema but is not functionally wired up for a
// RemoteMCPServer runtime); `auth.type: "OAuthPluginVault"`, the one MCP-supported scheme that DOES
// deliver a header, is a real per-user interactive OAuth 2.0 authorization-code flow requiring
// manual Teams Developer Portal registration per agent -- a materially different mechanism from "the
// same shared secret, just in a header," and a separate Matt-gated architecture decision, not a
// drop-in fix here.
//
// What THIS repo controls is the server side: validateBearer already treats the M365 static tokens
// identically regardless of how they arrive (a real `Authorization: Bearer` header, or the
// synthetic one requireConnectorAuth builds from the query-string fallback) -- these tests turn
// that from an incidental consequence of shared code into an explicitly pinned, tested contract, so
// the moment build-agents.mjs (or any other M365 caller) CAN send a real header, the server side
// needs zero further change to accept it. They also pin the deliberate, explicit decision to KEEP
// accepting the query-string fallback: rejecting it outright would lock out all six already-
// published M365 agents with no replacement mechanism available today.
test('M365: a static per-lane token presented via a REAL Authorization header authenticates, with m365_static_auth true', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth } = await import('./bearer.js');

  const app = Fastify();
  app.post('/mcp', async (request, reply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    return reply.send({ caller_agent: ctx.caller_agent, m365_static_auth: ctx.m365_static_auth });
  });

  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${M365_CTO_TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.caller_agent, 'cto');
  assert.equal(body.m365_static_auth, true);

  await app.close();
});

test('M365: the SAME token via the ?m365_dev_token= query-parameter fallback still authenticates (deliberate transition decision, pinned)', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth } = await import('./bearer.js');

  const app = Fastify();
  app.post('/mcp', async (request, reply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    return reply.send({ caller_agent: ctx.caller_agent, m365_static_auth: ctx.m365_static_auth });
  });

  const res = await app.inject({ method: 'POST', url: `/mcp?m365_dev_token=${M365_CTO_TOKEN}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.caller_agent, 'cto');
  assert.equal(body.m365_static_auth, true);

  await app.close();
});

test('M365: a real Authorization header takes precedence over a mismatched query-parameter token', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth } = await import('./bearer.js');

  const app = Fastify();
  app.post('/mcp', async (request, reply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    return reply.send({ caller_agent: ctx.caller_agent });
  });

  // A valid header token alongside a garbage query token must still succeed on the header's
  // identity -- requireConnectorAuth checks the header first and only falls back to the query
  // string when the header itself did not authenticate.
  const res = await app.inject({
    method: 'POST',
    url: '/mcp?m365_dev_token=not-a-real-token-at-all',
    headers: { authorization: `Bearer ${M365_CTO_TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().caller_agent, 'cto');

  await app.close();
});

test('M365: a forged token is rejected on both the header path and the query-parameter path', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth } = await import('./bearer.js');

  const app = Fastify();
  app.post('/mcp', async (request, reply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    return reply.send({ ok: true });
  });

  const forged = 'x'.repeat(40);
  const viaHeader = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${forged}` },
  });
  assert.equal(viaHeader.statusCode, 401);

  const viaQuery = await app.inject({ method: 'POST', url: `/mcp?m365_dev_token=${forged}` });
  assert.equal(viaQuery.statusCode, 401);

  await app.close();
});
