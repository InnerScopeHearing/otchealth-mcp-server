/**
 * Test-only env bootstrap. Importing this module (FIRST, before any module that
 * calls loadEnv() at import time) sets the minimum required env so loadEnv() in
 * config/env.ts succeeds. It deliberately leaves the optional Depot / PostHog /
 * Shopify / Intercom keys UNSET so the "not configured" paths can be tested.
 */

const REQUIRED_32 = 'x'.repeat(40);

const DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  CIO_SITE_ID: 'test-site',
  CIO_TRACK_KEY: 'test-track',
  CIO_APP_API_BEARER: 'test-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: REQUIRED_32,
  ADMIN_REVOKE_TOKEN: REQUIRED_32,
  N8N_WEBHOOK_SECRET: REQUIRED_32,
};

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
