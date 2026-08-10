import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test-site';
process.env.CIO_TRACK_KEY ||= 'test-track';
process.env.CIO_APP_API_BEARER ||= 'test-app';
process.env.CIO_FLY_SERVICE_ACCOUNT_TOKEN ||= ['sa', 'live', 'test_service_account'].join('_');
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'y'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'z'.repeat(32);
process.env.NODE_ENV = 'test';

const { flyGet, flyWrite, resetCioFlyTokenCacheForTests } = await import('./fly-client.js');

function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return fn().finally(() => {
    globalThis.fetch = original;
    resetCioFlyTokenCacheForTests();
  });
}

test('Fly client exchanges the service-account token, never sends it to resource endpoints, and uses the short JWT', { concurrency: false }, async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch((async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/service_accounts/oauth/token')) {
      assert.equal(init?.method, 'POST');
      assert.match(String(init?.body), /client_secret=sa_live_test_service_account/);
      return new Response(JSON.stringify({ access_token: 'short-jwt-1', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer short-jwt-1');
    assert.equal(String(init?.body).includes('sa_live_test_service_account'), false);
    return new Response(JSON.stringify({ score: 100 }), { status: 200 });
  }) as typeof fetch, async () => {
    assert.deepEqual(await flyGet('/v1/environments/193366/health'), { score: 100 });
  });
  assert.equal(calls.length, 2);
});

test('Fly client refreshes exactly once after a definitive 401 and retries the same read with the new JWT', { concurrency: false }, async () => {
  let exchanges = 0;
  let reads = 0;
  await withFetch((async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/v1/service_accounts/oauth/token')) {
      exchanges += 1;
      return new Response(JSON.stringify({ access_token: `short-jwt-${exchanges}`, expires_in: 3600 }), { status: 200 });
    }
    reads += 1;
    const auth = new Headers(init?.headers).get('authorization');
    if (reads === 1) {
      assert.equal(auth, 'Bearer short-jwt-1');
      return new Response(JSON.stringify({ errors: [{ detail: 'unauthorized' }] }), { status: 401 });
    }
    assert.equal(auth, 'Bearer short-jwt-2');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch, async () => {
    assert.deepEqual(await flyGet('/v1/environments/193366/goals'), { ok: true });
  });
  assert.equal(exchanges, 2);
  assert.equal(reads, 2);
});

test('Fly writes use strict validation and never retry a network-ambiguous mutation', { concurrency: false }, async () => {
  let writes = 0;
  await assert.rejects(
    withFetch((async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/service_accounts/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'short-jwt-write', expires_in: 3600 }), { status: 200 });
      }
      writes += 1;
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('x-validate'), 'strict');
      throw new Error('simulated ambiguous network failure');
    }) as typeof fetch, async () => {
      await flyWrite('POST', '/v1/environments/193366/frequency_caps', { frequency_cap: { name: 'One', rules: [] } });
    }),
    /Network error calling Customer\.io Journeys UI API POST/,
  );
  assert.equal(writes, 1);
});

test('Fly error guidance points only to Azure Key Vault and never to Notion or Railway', { concurrency: false }, async () => {
  await withFetch((async (url: string | URL) => {
    if (String(url).endsWith('/v1/service_accounts/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'short-jwt-error', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }) as typeof fetch, async () => {
    await assert.rejects(async () => flyGet('/v1/environments/193366/audit_logs'), (error: unknown) => {
      const candidate = error as { nextStep?: string };
      assert.match(candidate.nextStep ?? '', /Azure Key Vault/);
      assert.doesNotMatch(candidate.nextStep ?? '', /Notion|Railway/);
      return true;
    });
  });
});
