import { test } from 'node:test';
import assert from 'node:assert/strict';

// SAFETY-CRITICAL (2026-08-18, HIGH security finding): the gateway's own onResponse debug log
// must never echo a query-string credential (the M365 declarative-agent static per-lane token, an
// OAuth `code`/`state`) back out. See response-log.ts's doc comment for the full history: before
// this fix, index.ts's onResponse hook logged `url: request.url` verbatim -- the complete request
// URL including any query string -- and pino's field-path redact config cannot see inside a
// string to strip a substring, so nothing else in the stack caught this.

test('pathOnly strips the query string entirely, leaving nowhere for a secret to ride along', async () => {
  const { pathOnly } = await import('./response-log.js');
  assert.equal(pathOnly('/mcp?m365_dev_token=SUPERSECRET'), '/mcp');
  assert.equal(pathOnly('/oauth/authorize?code=abc123&state=xyz'), '/oauth/authorize');
  // No query string at all: unchanged (not a lossy transform for the common case).
  assert.equal(pathOnly('/mcp'), '/mcp');
  assert.equal(pathOnly('/health'), '/health');
});

test('SAFETY-CRITICAL: responseLogFields never includes a query-string secret in its url field', async () => {
  const { default: Fastify } = await import('fastify');
  const { responseLogFields } = await import('./response-log.js');

  const app = Fastify();
  let captured: Record<string, unknown> | undefined;
  app.get('/mcp', async (request, reply) => {
    captured = responseLogFields(request, reply, 12.3);
    return reply.send({ ok: true });
  });

  const secret = 'SUPERSECRETVALUE-do-not-log-me-0123456789';
  const res = await app.inject({ method: 'GET', url: `/mcp?m365_dev_token=${secret}` });
  assert.equal(res.statusCode, 200);
  assert.ok(captured, 'expected the route handler to run and capture the log payload');
  assert.equal(captured!.url, '/mcp');
  assert.ok(
    !JSON.stringify(captured).includes(secret),
    'the logged payload must never contain the raw token value anywhere in it',
  );

  await app.close();
});

test('responseLogFields still carries method, status, latency, and ip for real observability', async () => {
  const { default: Fastify } = await import('fastify');
  const { responseLogFields } = await import('./response-log.js');

  const app = Fastify();
  let captured: Record<string, unknown> | undefined;
  app.post('/mcp', async (request, reply) => {
    reply.code(201);
    captured = responseLogFields(request, reply, 42);
    return reply.send({ ok: true });
  });

  await app.inject({ method: 'POST', url: '/mcp' });
  assert.equal(captured!.type, 'http_response');
  assert.equal(captured!.method, 'POST');
  assert.equal(captured!.status, 201);
  assert.equal(captured!.latency_ms, 42);
  assert.ok('ip' in captured!);

  await app.close();
});
