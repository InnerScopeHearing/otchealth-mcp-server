import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerBrainSearch } from './brain-search.js';
import { requestContext } from '../../server/request-context.js';

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

test('chat_shared connector schema defaults to exec and refuses other Brain domains', () => {
  let inputSchema: Record<string, { parse(value: unknown): unknown }> | undefined;
  const server = {
    registerTool(_name: string, config: { inputSchema: Record<string, { parse(value: unknown): unknown }> }) {
      inputSchema = config.inputSchema;
      return { remove() {} };
    },
  };
  requestContext.run({
    callerHash: 'synthetic-caller-hash',
    correlationId: 'synthetic-correlation',
    callerAgent: 'chat_shared',
    connectorSurface: true,
    m365StaticAuth: false,
  }, () => registerBrainSearch(server as never, () => 'synthetic-caller-hash'));

  assert.ok(inputSchema);
  assert.equal(inputSchema.domain.parse(undefined), 'exec');
  assert.equal(inputSchema.domain.parse('exec'), 'exec');
  assert.throws(() => inputSchema.domain.parse('commons'));
  assert.throws(() => inputSchema.domain.parse('finance'));
  assert.throws(() => inputSchema.domain.parse('legal'));
});
