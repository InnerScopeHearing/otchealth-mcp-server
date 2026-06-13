/**
 * Test-only env bootstrap. Importing this module (FIRST, before any module that
 * calls loadEnv() at import time) sets the minimum required env so loadEnv() in
 * config/env.ts succeeds. It deliberately leaves the optional Depot / PostHog /
 * Shopify / Intercom keys UNSET so the "not configured" paths can be tested.
 */

// Distinct values per secret so tests prove the credentials are independent
// (a conflation bug, e.g. consent secret == connector token, would now fail).
const DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  CIO_SITE_ID: 'test-site',
  CIO_TRACK_KEY: 'test-track',
  CIO_APP_API_BEARER: 'test-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: 'c'.repeat(40),
  ADMIN_REVOKE_TOKEN: 'a'.repeat(40),
  OAUTH_CONSENT_SECRET: 's'.repeat(40),
  N8N_WEBHOOK_SECRET: 'n'.repeat(40),
  PUBLIC_BASE_URL: 'https://mcp.test.example',
};

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
