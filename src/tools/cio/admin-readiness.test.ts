import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test-site';
process.env.CIO_TRACK_KEY ||= 'test-track';
process.env.CIO_APP_API_BEARER ||= 'test-app';
process.env.CIO_FLY_SERVICE_ACCOUNT_TOKEN ||= ['sa', 'live', 'test_service_account'].join('_');
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'y'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'z'.repeat(32);
process.env.CIO_WORKSPACE_ID = '193366';
process.env.NODE_ENV = 'test';

const { getCioDesignReadiness } = await import('./admin-readiness.js');
const { resetCioFlyTokenCacheForTests } = await import('../../customerio/fly-client.js');

test('Design readiness parses live-shaped responses, checks links/images, and returns content-free receipts', { concurrency: false }, async () => {
  const original = globalThis.fetch;
  const body = '<html lang="en"><head><title>Care</title></head><body><h1>Guide</h1><img src="https://cdn.example.com/hero.png" alt="Guide"><a href="https://example.com/guide">Read</a>{% unsubscribe %}</body></html>';
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const value = String(url);
    if (value.endsWith('/v1/service_accounts/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'readiness-jwt', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer readiness-jwt');
    if (value.endsWith('/design_studio/emails/email-1')) {
      return new Response(JSON.stringify({
        email: {
          id: 'email-1',
          name: 'Care guide',
          is_linked: true,
          content: { html: body, subject: 'Care guide' },
          envelope: { from: 'OTCHealth <care@example.com>' },
          transformers: { accessibility: { enabled: true } },
        },
      }), { status: 200 });
    }
    if (value.endsWith('/design_studio/emails/email-1/unpublished_changes')) {
      return new Response(JSON.stringify({ unpublished_changes: false }), { status: 200 });
    }
    if (value.endsWith('/previews/link_statuses')) {
      const request = JSON.parse(String(init?.body)) as { urls: string[] };
      assert.deepEqual(request.urls.sort(), ['https://cdn.example.com/hero.png', 'https://example.com/guide'].sort());
      return new Response(JSON.stringify({
        urls: [
          { url: 'https://cdn.example.com/hero.png', status_code: 200, timeout: false, error: '' },
          { url: 'https://example.com/guide', status_code: 503, timeout: false, error: 'upstream unavailable' },
        ],
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${value}`);
  }) as typeof fetch;

  try {
    const result = await getCioDesignReadiness({
      resourceType: 'design_studio_email',
      resourceId: 'email-1',
      checkLinks: true,
    });
    assert.equal(result.ready_for_human_review, false);
    assert.equal((result.accessibility as Record<string, unknown>).status, 'pass_static');
    assert.equal((result.links as Record<string, unknown>).failures, 1);
    assert.equal((result.images as Record<string, unknown>).failures, 0);
    assert.equal((result.spam_status as Record<string, unknown>).status, 'not_available');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(body), false);
    assert.equal(serialized.includes('https://example.com/guide'), false);
    assert.match(serialized, /[a-f0-9]{64}/);
  } finally {
    globalThis.fetch = original;
    resetCioFlyTokenCacheForTests();
  }
});
