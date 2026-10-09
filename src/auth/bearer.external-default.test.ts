import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition } from '../tools/registry.js';

const CONNECTOR_TOKEN = 'external-connector-' + 'x'.repeat(32);
const SIGNING_SECRET = 'external-signing-' + 's'.repeat(40);
const LEGACY_OAUTH_CLIENT_ID = 'legacy-external-connector-without-prefix';

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: CONNECTOR_TOKEN,
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    NODE_ENV: 'test',
    REVOCATION_MEMORY_ONLY_MODE: 'development',
    OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
    OAUTH_CLIENT_ID: LEGACY_OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET: 'external-client-secret-' + 'c'.repeat(32),
    OAUTH_DEFAULT_AGENT: 'external-read',
    // Deliberately try to smuggle a stripped GitHub alias onto the external surface. The real
    // registration sink must evaluate its canonical identity and refuse it.
    EXTERNAL_READONLY_TOOLSET: 'brain_search,push_files',
  };
  for (const [key, value] of Object.entries(required)) process.env[key] = value;
});

test('PERPLEXITY_CONNECTOR_TOKEN mapped to an external lane receives the curated connector surface', async () => {
  const { validateBearer } = await import('./bearer.js');
  const { issueAccessToken } = await import('./oauth-tokens.js');
  const { requestContext } = await import('../server/request-context.js');
  const { registerTool } = await import('../tools/registry.js');
  const ctx = await validateBearer(`Bearer ${CONNECTOR_TOKEN}`);

  assert.ok(ctx);
  assert.equal(ctx.caller_agent, 'external-read');
  assert.equal(ctx.connector_surface, true);
  assert.equal(ctx.m365_static_auth, false);

  const legacyToken = issueAccessToken(
    LEGACY_OAUTH_CLIENT_ID,
    'mcp',
    SIGNING_SECRET,
    'https://external.invalid',
    'external-read',
  );
  const legacyCtx = await validateBearer(`Bearer ${legacyToken}`);
  assert.ok(legacyCtx);
  assert.equal(legacyCtx.caller_agent, 'external-read');
  assert.equal(
    legacyCtx.connector_surface,
    true,
    'the single legacy OAuth connector is curated even when its configured id has no connector prefix',
  );

  const registered: string[] = [];
  const server = {
    registerTool: (name: string) => {
      registered.push(name);
      return { remove: () => undefined };
    },
  } as unknown as McpServer;
  const definition = (
    name: string,
    canonicalName?: string,
  ): ToolDefinition<Record<string, never>, Record<string, never>> => ({
    name,
    canonicalName,
    category: 'read',
    annotations: {
      title: name,
      description: name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: {},
    outputShape: {},
    handler: async () => ({ data: null }),
  });

  requestContext.run({
    callerHash: legacyCtx.caller_hash,
    correlationId: 'external-auth-registration',
    callerAgent: legacyCtx.caller_agent,
    connectorSurface: legacyCtx.connector_surface,
    m365StaticAuth: legacyCtx.m365_static_auth,
  }, () => {
    registerTool(server, definition('brain_search'), () => legacyCtx.caller_hash, true);
    registerTool(server, definition('push_files', 'github_push_files'), () => legacyCtx.caller_hash, true);
  });

  assert.deepEqual(
    registered,
    ['brain_search'],
    'the authenticated external connector must not register a GitHub capability hidden by an alias',
  );
});
