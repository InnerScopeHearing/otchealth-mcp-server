import { test } from 'node:test';
import assert from 'node:assert/strict';

// Match the required configuration stubs used by the other provider tests, then deliberately
// poison the legacy Foundry settings to prove they cannot reactivate the retired provider.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER = 'foundry';
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://retired-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'test-retired-foundry-key';
process.env.SHIELD_MODE = 'off';
process.env.GROUNDEDNESS_MODE = 'off';

const { registerClaimsCheck } = await import('./claims-check.js');

test('claims_check reports retired Foundry truthfully and never makes an Azure request', async () => {
  type RegisteredHandler = (args: unknown) => Promise<unknown>;
  let registeredName = '';
  let registeredConfig: { description?: string } = {};
  let handler: RegisteredHandler | undefined;
  const server = {
    registerTool: (name: string, config: unknown, registeredHandler: RegisteredHandler) => {
      registeredName = name;
      registeredConfig = config as typeof registeredConfig;
      handler = registeredHandler;
      return { remove: () => undefined };
    },
  } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;

  registerClaimsCheck(server, () => 'synthetic-caller-hash');
  assert.equal(registeredName, 'claims_check');
  assert.match(registeredConfig.description ?? '', /configured OpenAI-direct model/);
  assert.doesNotMatch(registeredConfig.description ?? '', /credit-funded Azure Foundry/);
  assert.ok(handler, 'registerClaimsCheck must register a callable handler');

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('retired Foundry must not be contacted');
  }) as typeof fetch;
  let result: unknown;
  try {
    result = await handler({ text: 'A personal sound amplifier for everyday listening.', channel: 'web', productClass: 'PSAP' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rendered = JSON.stringify(result);
  assert.match(rendered, /provider_retired/);
  assert.match(rendered, /Foundry is retired and disabled; no Azure request was made\./);
  assert.doesNotMatch(rendered, /Foundry endpoint\/key not configured/);
  assert.equal(networkCalls, 0, 'retired Foundry settings must not produce a provider request');
});
