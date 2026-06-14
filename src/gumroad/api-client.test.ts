import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy the required env vars so loadEnv() succeeds; leave GUMROAD_ACCESS_TOKEN unset.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
delete process.env.GUMROAD_ACCESS_TOKEN;

const { listProducts, listSales, GumroadApiError } = await import('./api-client.js');

test('gumroad: listProducts rejects with a configuration error when the token is unset', async () => {
  await assert.rejects(() => listProducts(), (err: unknown) => {
    assert.ok(err instanceof GumroadApiError);
    assert.equal((err as InstanceType<typeof GumroadApiError>).code, 'gumroad_not_configured');
    return true;
  });
});

test('gumroad: listSales rejects with a configuration error when the token is unset', async () => {
  await assert.rejects(() => listSales({ after: '2026-06-01' }), /GUMROAD_ACCESS_TOKEN is not set/);
});
