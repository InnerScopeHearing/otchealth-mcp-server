import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const SIGNING_SECRET = 'duplicate-client-signing-' + 's'.repeat(40);
const DUPLICATE_CLIENT_ID = 'configured-in-both-oauth-slots';

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'duplicate-precedence-' + 'p'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    NODE_ENV: 'test',
    REVOCATION_MEMORY_ONLY_MODE: 'development',
    OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
    OAUTH_CLIENT_ID: DUPLICATE_CLIENT_ID,
    OAUTH_CLIENT_SECRET: 'legacy-secret-' + 'l'.repeat(32),
    OAUTH_DEFAULT_AGENT: 'cfo',
    OAUTH_CLIENTS: JSON.stringify([{
      client_id: DUPLICATE_CLIENT_ID,
      secret: 'machine-secret-' + 'm'.repeat(32),
      agent: 'developer',
    }]),
  };
  for (const [key, value] of Object.entries(required)) process.env[key] = value;
});

test('valid duplicate client id preserves OAUTH_CLIENTS precedence over the single legacy connector', async () => {
  const { validateBearer } = await import('./bearer.js');
  const { issueAccessToken } = await import('./oauth-tokens.js');
  const token = issueAccessToken(
    DUPLICATE_CLIENT_ID,
    'mcp',
    SIGNING_SECRET,
    'https://precedence.invalid',
    'developer',
  );
  const ctx = await validateBearer(`Bearer ${token}`);

  assert.ok(ctx);
  assert.equal(ctx.caller_agent, 'developer');
  assert.equal(
    ctx.connector_surface,
    false,
    'resolveClient selects OAUTH_CLIENTS first, so bearer must preserve its internal-catalog behavior',
  );
});

test('legacy connector classification matches resolveClient behavior for malformed and distinct OAUTH_CLIENTS', async () => {
  const { isLegacyOAuthConnectorClient } = await import('./bearer.js');

  assert.equal(
    isLegacyOAuthConnectorClient(DUPLICATE_CLIENT_ID, DUPLICATE_CLIENT_ID, '{malformed'),
    true,
    'malformed OAUTH_CLIENTS is ignored by resolveClient and must not declassify the single connector',
  );
  assert.equal(
    isLegacyOAuthConnectorClient(
      DUPLICATE_CLIENT_ID,
      DUPLICATE_CLIENT_ID,
      JSON.stringify([{ client_id: 'different-machine-client' }]),
    ),
    true,
  );
  assert.equal(
    isLegacyOAuthConnectorClient(
      DUPLICATE_CLIENT_ID,
      DUPLICATE_CLIENT_ID,
      JSON.stringify([{ client_id: DUPLICATE_CLIENT_ID }]),
    ),
    false,
  );
});
