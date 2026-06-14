import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy the required env vars so loadEnv() succeeds; leave NETLIFY_AUTH_TOKEN unset.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
delete process.env.NETLIFY_AUTH_TOKEN;

const { listSites, listSiteDeploys, NetlifyApiError } = await import('./api-client.js');

test('netlify: listSites rejects with a configuration error when the token is unset', async () => {
  await assert.rejects(() => listSites(), (err: unknown) => {
    assert.ok(err instanceof NetlifyApiError);
    assert.equal((err as InstanceType<typeof NetlifyApiError>).code, 'netlify_not_configured');
    return true;
  });
});

test('netlify: listSiteDeploys rejects with a configuration error when the token is unset', async () => {
  await assert.rejects(() => listSiteDeploys('site_123'), /NETLIFY_AUTH_TOKEN is not set/);
});
