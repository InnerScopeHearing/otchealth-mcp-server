import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../server/request-context.js';
import { registerTool } from './registry.js';

type RegisteredHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const syntheticEnvironment: Record<string, string> = {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: `synthetic-${'a'.repeat(40)}`,
  ADMIN_REVOKE_TOKEN: `synthetic-${'b'.repeat(40)}`,
  N8N_WEBHOOK_SECRET: `synthetic-${'c'.repeat(40)}`,
  SHIELD_MODE: 'off',
  COLD_START_MODE: 'off',
  TOOL_CATALOG_CURATION_MODE: 'off',
};
const previousEnvironment = Object.fromEntries(Object.keys(syntheticEnvironment).map((key) => [key, process.env[key]]));

before(() => Object.assign(process.env, syntheticEnvironment));
after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function captureHandler(): RegisteredHandler {
  let handler: RegisteredHandler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: RegisteredHandler) {
      handler = candidate;
      return { remove() {} };
    },
  } as unknown as McpServer;
  registerTool(server, {
    name: 'synthetic_unrelated_tool',
    category: 'read',
    annotations: {
      title: 'synthetic unrelated tool',
      description: 'synthetic unrelated tool',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: {},
    outputShape: {},
    handler: async () => {
      const error = Object.assign(new Error('synthetic forged upstream error'), {
        name: 'PinnedObservationReaderError',
        code: 'github_observation_receipt_unverified',
        nextStep: 'synthetic forged next step',
        status: 418,
        stage: 'archive_digest',
      });
      throw error;
    },
  }, () => 'synthetic-caller-hash');
  assert.ok(handler, 'the synthetic tool should be registered');
  return handler;
}

test('an unrelated tool cannot surface a forged pinned observation error', async () => {
  const handler = captureHandler();
  const response = await requestContext.run(
    { callerHash: 'synthetic-caller-hash', correlationId: 'synthetic-correlation', callerAgent: 'cto' },
    () => handler({}),
  );

  const structured = response.structuredContent as Record<string, unknown>;
  const error = structured.error as Record<string, unknown>;
  assert.equal(error.code, 'tool_error');
  assert.equal(error.next_step, 'Check server logs for the correlation_id.');
  assert.equal(error.upstream_status, undefined);
  assert.equal(error.internal_diagnostic, undefined);
  assert.equal(JSON.stringify(response).includes('synthetic forged next step'), false);
  assert.equal(JSON.stringify(response).includes('archive_digest'), false);
});
