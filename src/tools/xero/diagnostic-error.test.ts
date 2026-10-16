import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.XERO_CLIENT_ID ||= 'test-client-id';
process.env.XERO_CLIENT_SECRET ||= 'test-client-secret';
process.env.XERO_RT_OTCHEALTH ||= 'bootstrap-rt-otchealth';
process.env.COSMOS_ENDPOINT ||= 'https://test.documents.azure.com';
process.env.COSMOS_DB ||= 'test';
process.env.COSMOS_KEY ||= Buffer.from('test-key').toString('base64');

const { bootstrapHash, buildTokenDoc, xeroGet } = await import('./client.js');
const { XeroHttpError, projectXeroFailure } = await import('./diagnostic-error.js');

function preparedDeps(status: number, responseBody: string) {
  const envRefreshToken = process.env.XERO_RT_OTCHEALTH as string;
  const doc = buildTokenDoc({
    org: 'otchealth', refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access',
    expiresInSeconds: 1800, tenantId: 'synthetic-tenant', tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(envRefreshToken),
  });
  return {
    fetchImpl: (async () => new Response(responseBody, { status })) as typeof fetch,
    read: (async () => ({ doc, etag: 'synthetic-etag' })) as never,
    replace: (async () => { throw new Error('unexpected token replacement'); }) as never,
    create: (async () => { throw new Error('unexpected token creation'); }) as never,
  } as never;
}

for (const [status, expectedCode] of [
  [429, 'xero_http_rate_limited'],
  [503, 'xero_http_upstream_error'],
] as const) {
  test(`xeroGet classifies synthetic HTTP ${status} without exposing body in diagnostic projection`, async () => {
    const secretLikeBody = 'SYNTHETIC_SECRET_LIKE_PROVIDER_BODY_DO_NOT_PROJECT';
    await assert.rejects(
      xeroGet('otchealth', '/SyntheticReadOnlyProbe', {}, { deps: preparedDeps(status, secretLikeBody) }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, `Xero GET /SyntheticReadOnlyProbe (otchealth) -> HTTP ${status}: ${secretLikeBody}`);
        assert.ok(err instanceof XeroHttpError);
        assert.equal((err as Error & { status?: number }).status, status);
        assert.equal((err as XeroHttpError).stage, 'accounting_get');
        assert.equal(projectXeroFailure(err, 'xero_aggregate'), expectedCode);
        assert.equal(projectXeroFailure(err, 'other_vendor_tool'), null);
        assert.doesNotMatch(String(projectXeroFailure(err, 'xero_aggregate')), /SYNTHETIC_SECRET_LIKE_PROVIDER_BODY_DO_NOT_PROJECT/);
        return true;
      },
    );
  });
}

test('classifier rejects ordinary errors and spoofed property bags', async () => {
  const ordinary = new Error('HTTP 429 SYNTHETIC_SECRET_LIKE_PROVIDER_BODY_DO_NOT_PROJECT');
  assert.equal(projectXeroFailure(ordinary, 'xero_aggregate'), null);
  assert.equal(projectXeroFailure({ name: 'XeroHttpError', status: 429 }, 'xero_aggregate'), null);
  assert.equal(projectXeroFailure(ordinary, 'vendor_xero_tool'), null);
});

test('classifier ignores successful 2xx statuses even on a typed error instance', () => {
  const err = new XeroHttpError('accounting_get', 200, 'synthetic success-shaped status');
  assert.equal(projectXeroFailure(err, 'xero_aggregate'), null);
});

for (const [status, expectedCode, stage] of [
  [401, 'xero_http_unauthorized', 'refresh'],
  [403, 'xero_http_forbidden', 'connections'],
  [400, 'xero_http_request_error', 'connections'],
] as const) {
  test(`classifier maps HTTP ${status} to a fixed code independent of message`, () => {
    const err = new XeroHttpError(stage, status, 'SYNTHETIC_SECRET_LIKE_PROVIDER_BODY_DO_NOT_PROJECT');
    assert.equal(projectXeroFailure(err, 'xero_orgs'), expectedCode);
    assert.doesNotMatch(String(projectXeroFailure(err, 'xero_orgs')), /SYNTHETIC_SECRET_LIKE_PROVIDER_BODY_DO_NOT_PROJECT/);
  });
}
