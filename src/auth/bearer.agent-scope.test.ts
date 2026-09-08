import test from 'node:test';
import assert from 'node:assert/strict';

const LEGACY_TOKEN = 'synthetic-legacy-' + 'l'.repeat(40);
const SIGNING_SECRET = 'synthetic-signing-' + 's'.repeat(40);

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: LEGACY_TOKEN,
  ADMIN_REVOKE_TOKEN: 'synthetic-admin-' + 'a'.repeat(40),
  N8N_WEBHOOK_SECRET: 'synthetic-webhook-' + 'n'.repeat(40),
  OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
  OAUTH_DEFAULT_AGENT: '',
  REVOCATION_MEMORY_ONLY_MODE: 'development',
  SHIELD_MODE: 'off',
  COLD_START_MODE: 'off',
  TOOL_CATALOG_CURATION_MODE: 'off',
});

test('a legacy external token with no default lane is rejected before request context creation', async () => {
  const { default: Fastify } = await import('fastify');
  const { requireConnectorAuth, validateBearer } = await import('./bearer.js');
  assert.equal(await validateBearer('Bearer ' + LEGACY_TOKEN, () => true), null);

  const app = Fastify();
  let contextCreated = false;
  app.post('/mcp', async (request, reply) => {
    const auth = await requireConnectorAuth(request, reply, () => true);
    if (!auth) return;
    contextCreated = true;
    return reply.send({ ok: true });
  });
  const response = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer ' + LEGACY_TOKEN } });
  assert.equal(response.statusCode, 401);
  assert.equal(contextCreated, false);
  await app.close();
});

test('an otherwise valid issued token with a whitespace-only lane is rejected', async () => {
  const { validateBearer } = await import('./bearer.js');
  const { issueAccessToken } = await import('./oauth-tokens.js');
  const token = issueAccessToken('synthetic-client', 'mcp', SIGNING_SECRET, 'https://synthetic.invalid', '   ');
  assert.equal(await validateBearer('Bearer ' + token, () => true), null);
});

test('a valid issued identity reaches only its normalized own lane through request context and registry', async () => {
  const { z } = await import('zod');
  const { validateBearer } = await import('./bearer.js');
  const { issueAccessToken } = await import('./oauth-tokens.js');
  const { requestContext } = await import('../server/request-context.js');
  const { registerTool } = await import('../tools/registry.js');
  const { resolveAgentReadScope } = await import('../tools/memory/agent-scope.js');

  const token = issueAccessToken('synthetic-client', 'mcp', SIGNING_SECRET, 'https://synthetic.invalid', 'synthetic-company');
  const auth = await validateBearer('Bearer ' + token, () => true);
  assert.ok(auth);
  let handler;
  const server = { registerTool(_name, _config, candidate) { handler = candidate; return { remove() {} }; } };
  registerTool(server, {
    name: 'synthetic_scope_probe',
    category: 'read',
    annotations: { title: 'scope', description: 'scope', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: { agent: z.string() },
    outputShape: { allowed: z.boolean(), agent: z.string() },
    handler: async (input, ctx) => ({ data: resolveAgentReadScope(input.agent, ctx.callerAgent), summary: 'scope' }),
  }, () => auth.caller_hash);

  const invoke = (agent) => requestContext.run(
    { callerHash: auth.caller_hash, correlationId: 'synthetic', callerAgent: auth.caller_agent },
    () => handler({ agent }),
  );
  const own = await invoke(' SYNTHETIC-COMPANY ');
  const other = await invoke('synthetic-protected');
  assert.deepEqual(own.structuredContent.result, { allowed: true, agent: 'synthetic-company' });
  assert.deepEqual(other.structuredContent.result, { allowed: false, agent: 'synthetic-company' });
});
