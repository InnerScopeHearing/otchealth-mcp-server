import { test, before } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [key, value] of Object.entries(required)) process.env[key] ??= value;
});

test('MCP request context keeps token identity separate from the task-class header', async () => {
  const { requestContextForMcpRequest } = await import('./mcp.js');
  const { currentCallerAgent, currentTaskClass, requestContext } = await import('./request-context.js');
  const authenticated = {
    caller_hash: 'authenticated-caller-hash',
    raw_token: '',
    caller_agent: 'coo',
    connector_surface: true,
    m365_static_auth: false,
  };

  const engineeringContext = requestContextForMcpRequest(authenticated, 'corr-1', 'engineering');
  assert.equal(engineeringContext.callerAgent, 'coo');
  assert.equal(engineeringContext.taskClass, 'engineering');
  await requestContext.run(engineeringContext, async () => {
    assert.equal(currentCallerAgent(), 'coo');
    assert.equal(currentTaskClass(), 'engineering');
  });

  const missingContext = requestContextForMcpRequest(authenticated, 'corr-2', undefined);
  assert.equal(missingContext.callerAgent, 'coo');
  assert.equal(missingContext.taskClass, undefined);

  const invalidContext = requestContextForMcpRequest(authenticated, 'corr-3', 'unknown');
  assert.equal(invalidContext.callerAgent, 'coo');
  assert.equal(invalidContext.taskClass, undefined);

  const readOnlyContext = requestContextForMcpRequest(authenticated, 'corr-4', 'read_only');
  assert.equal(readOnlyContext.callerAgent, 'coo');
  assert.equal(readOnlyContext.taskClass, 'read_only');
});
