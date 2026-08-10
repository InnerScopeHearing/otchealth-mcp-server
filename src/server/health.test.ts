import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Set required env vars before importing the module (loadEnv runs at import time).
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) {
    process.env[k] ??= v;
  }
});

test('buildHealthPayload returns expected shape with status ok', async () => {
  const { buildHealthPayload } = await import('./health.js');
  const payload = buildHealthPayload();

  assert.equal(payload.status, 'ok');
  assert.equal(payload.service, 'otchealth-mcp-server');
  assert.equal(typeof payload.time, 'string');
  assert.ok('env' in payload);
  assert.ok('read_only_mode' in payload);
  assert.ok('connector_token_revoked' in payload);
  assert.deepEqual(payload.heygen, {
    reference_look_writes: false,
    video_agent_chat_writes: false,
    video_agent_generation: false,
    asset_writes: false,
    translation_writes: false,
    tts_writes: false,
    metadata_writes: false,
    owner_approval_verifier_configured: false,
  });
});
