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
});

// Regression guard: GOVERNANCE_MODE (the charter-enforcer rollout switch) must be visible on
// /health so an ops flip via the app-settings env is observable without a redeploy.
test('buildHealthPayload includes governance_mode, defaulting to "off" when GOVERNANCE_MODE is unset', async () => {
  delete process.env.GOVERNANCE_MODE;
  const { buildHealthPayload } = await import('./health.js');
  const payload = buildHealthPayload();
  assert.equal(payload.governance_mode, 'off');
});

test('buildHealthPayload reflects a non-default GOVERNANCE_MODE', async () => {
  const prev = process.env.GOVERNANCE_MODE;
  process.env.GOVERNANCE_MODE = 'report';
  try {
    const { buildHealthPayload } = await import('./health.js');
    const payload = buildHealthPayload();
    assert.equal(payload.governance_mode, 'report');
  } finally {
    if (prev === undefined) delete process.env.GOVERNANCE_MODE;
    else process.env.GOVERNANCE_MODE = prev;
  }
});
