import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentReadScope } from './agent-scope.js';
import { registerWake } from './wake.js';
import { registerMemoryPack } from './pack.js';
import { requestContext } from '../../server/request-context.js';

type RegisteredHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

function captureHandler(register: (server: never, callerHash: () => string) => void): RegisteredHandler {
  let handler: RegisteredHandler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: RegisteredHandler) {
      handler = candidate;
      return { remove() {} };
    },
  };
  register(server as never, () => 'synthetic-caller-hash');
  assert.ok(handler);
  return handler;
}

async function callAsSyntheticCompany(register: (server: never, callerHash: () => string) => void) {
  const synthetic = {
    CIO_SITE_ID: 'synthetic-site',
    CIO_TRACK_KEY: 'synthetic-track-key',
    CIO_APP_API_BEARER: 'synthetic-bearer-placeholder',
    PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-connector-placeholder-1234567890',
    ADMIN_REVOKE_TOKEN: 'synthetic-admin-placeholder-1234567890',
    N8N_WEBHOOK_SECRET: 'synthetic-webhook-placeholder-1234567890',
  };
  const prior = Object.fromEntries(Object.keys(synthetic).map((key) => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  try {
    const handler = captureHandler(register);
    return await requestContext.run(
      { callerHash: 'synthetic-caller-hash', correlationId: 'synthetic-correlation', callerAgent: 'synthetic-company' },
      () => handler({ agent: 'synthetic-protected' }),
    );
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('authenticated company callers can select only their own normalized lane', () => {
  assert.deepEqual(resolveAgentReadScope(undefined, 'synthetic-company'), { allowed: true, agent: 'synthetic-company' });
  assert.deepEqual(resolveAgentReadScope(' SYNTHETIC-COMPANY ', 'synthetic-company'), { allowed: true, agent: 'synthetic-company' });
  assert.deepEqual(resolveAgentReadScope('synthetic-protected', 'synthetic-company'), { allowed: false, agent: 'synthetic-company' });
  assert.deepEqual(resolveAgentReadScope('cto', 'synthetic-company'), { allowed: false, agent: 'synthetic-company' });
  assert.deepEqual(resolveAgentReadScope('clo-personal', 'clo'), { allowed: false, agent: 'clo' },
    'corporate CLO startup must never select the personal-legal wake/pack lane');
});

test('a protected-lane caller retains own-lane access but cannot select a company lane', () => {
  assert.deepEqual(resolveAgentReadScope(undefined, 'synthetic-protected'), { allowed: true, agent: 'synthetic-protected' });
  assert.deepEqual(resolveAgentReadScope('synthetic-protected', 'synthetic-protected'), { allowed: true, agent: 'synthetic-protected' });
  assert.deepEqual(resolveAgentReadScope('synthetic-company', 'synthetic-protected'), { allowed: false, agent: 'synthetic-protected' });
});

test('caller-less internal compatibility remains explicit-agent only', () => {
  assert.equal(resolveAgentReadScope(undefined, ''), null);
  assert.deepEqual(resolveAgentReadScope('synthetic-lane', ''), { allowed: true, agent: 'synthetic-lane' });
});

test('malformed requested or caller lanes fail closed during normalization', () => {
  assert.throws(() => resolveAgentReadScope('../synthetic', 'synthetic-company'), /invalid agent/);
  assert.throws(() => resolveAgentReadScope('synthetic-company', '../synthetic'), /invalid agent/);
});

test('wake rejects a cross-agent request before building any section', async () => {
  const response = await callAsSyntheticCompany(registerWake as never);
  const result = (response.structuredContent as Record<string, unknown>).result as Record<string, unknown>;
  assert.deepEqual(result.errors, ['forbidden_agent']);
  assert.equal(result.agent, 'synthetic-company');
  assert.equal(result.pack, null);
  assert.deepEqual(result.memory_records, []);
  assert.equal(result.tasks, null);
  assert.equal(result.inbox, null);
  assert.equal(result.inbound, null);
});

test('memory_pack rejects the same cross-agent request with an empty caller-bound result', async () => {
  const response = await callAsSyntheticCompany(registerMemoryPack as never);
  const result = (response.structuredContent as Record<string, unknown>).result as Record<string, unknown>;
  assert.deepEqual(result, {
    agent: 'synthetic-company',
    status: null,
    corrections: [],
    decisions: [],
    recent: [],
    count: 0,
  });
  const message = (response.content as Array<{ text: string }>)[0]?.text ?? '';
  assert.match(message, /forbidden_agent/);
});
