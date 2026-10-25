import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasRevenueCatProjectCredential,
  resolveRevenueCatApiKey,
} from './credential-resolver.js';

const globalKey = 'sk_global_synthetic_key_123456';
const awareKey = 'sk_aware_synthetic_key_123456';
const otherKey = 'sk_other_synthetic_key_123456';
const mapping = JSON.stringify({
  proja2cc4776: 'REVENUECAT_PROJECT_KEY_AWARE',
  projother123: 'REVENUECAT_PROJECT_KEY_OTHER',
});

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(values)) {
    previous.set(name, process.env[name]);
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { run(); }
  finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('RevenueCat resolver isolates mapped project keys and preserves global fallback for unmapped projects', () => {
  withEnv({
    REVENUECAT_API_KEY: globalKey,
    REVENUECAT_PROJECT_KEY_ENV_JSON: mapping,
    REVENUECAT_PROJECT_KEY_AWARE: awareKey,
    REVENUECAT_PROJECT_KEY_OTHER: otherKey,
  }, () => {
    assert.equal(resolveRevenueCatApiKey('proja2cc4776'), awareKey);
    assert.equal(resolveRevenueCatApiKey('projother123'), otherKey);
    assert.equal(resolveRevenueCatApiKey('projunmapped123'), globalKey);
    assert.equal(resolveRevenueCatApiKey(), globalKey);
    assert.equal(hasRevenueCatProjectCredential('proja2cc4776'), true);
    assert.equal(hasRevenueCatProjectCredential('projunmapped123'), false);
  });
});

test('mapped missing or invalid project keys fail closed without returning key material', () => {
  for (const invalidKey of [undefined, 'not-a-secret', 'sk_short', 'sk_bad\nheader']) {
    withEnv({
      REVENUECAT_API_KEY: globalKey,
      REVENUECAT_PROJECT_KEY_ENV_JSON: mapping,
      REVENUECAT_PROJECT_KEY_AWARE: invalidKey,
      REVENUECAT_PROJECT_KEY_OTHER: otherKey,
    }, () => {
      assert.equal(hasRevenueCatProjectCredential('proja2cc4776'), false);
      assert.throws(() => resolveRevenueCatApiKey('proja2cc4776'), (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.doesNotMatch((error as Error).message, /sk_/);
        if (invalidKey) assert.equal((error as Error).message.includes(invalidKey), false);
        return true;
      });
    });
  }
});

test('malformed or unsafe project-key mappings fail closed rather than using the global key', () => {
  for (const badMapping of ['{', '[]', 'null', '{"proja2cc4776":"PATH"}', '{"../project":"REVENUECAT_PROJECT_KEY_AWARE"}']) {
    withEnv({
      REVENUECAT_API_KEY: globalKey,
      REVENUECAT_PROJECT_KEY_ENV_JSON: badMapping,
      REVENUECAT_PROJECT_KEY_AWARE: awareKey,
    }, () => {
      assert.equal(hasRevenueCatProjectCredential('proja2cc4776'), false);
      assert.throws(() => resolveRevenueCatApiKey('proja2cc4776'), (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.doesNotMatch((error as Error).message, /sk_/);
        assert.doesNotMatch((error as Error).message, /PATH|\.\.\/project/);
        return true;
      });
    });
  }

  withEnv({ REVENUECAT_API_KEY: globalKey, REVENUECAT_PROJECT_KEY_ENV_JSON: mapping }, () => {
    assert.throws(() => resolveRevenueCatApiKey('proj/../../outside'));
  });
});

test('all RevenueCat clients route mapped project paths to that project key and keep unscoped calls global', async () => {
  const previous = new Map<string, string | undefined>();
  const configured: Record<string, string> = {
    REVENUECAT_API_KEY: globalKey,
    REVENUECAT_PROJECT_KEY_ENV_JSON: mapping,
    REVENUECAT_PROJECT_KEY_AWARE: awareKey,
    REVENUECAT_PROJECT_KEY_OTHER: otherKey,
  };
  for (const [name, value] of Object.entries(configured)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      method: init?.method ?? 'GET',
    });
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const api = await import('./api-client.js');
    const full = await import('./full-client.js');
    const write = await import('./write-client.js');

    await api.listProjects();
    await full.getProject('proja2cc4776');
    await full.getProject('projunmapped123');
    await write.grantEntitlement({
      project_id: 'proja2cc4776', subscriber_id: 'synthetic-subscriber',
      entitlement_id: 'aware_pro', duration: 'monthly',
    });
    await write.setSubscriberAttributes({ app_user_id: 'synthetic-user', attributes: { source: { value: 'test' } } });

    assert.deepEqual(requests.map((r) => r.authorization), [
      `Bearer ${globalKey}`,
      `Bearer ${awareKey}`,
      `Bearer ${globalKey}`,
      `Bearer ${awareKey}`,
      `Bearer ${globalKey}`,
    ]);
    assert.equal(requests[1]?.url, 'https://api.revenuecat.com/v2/projects/proja2cc4776');
    assert.equal(requests[3]?.method, 'POST');
    assert.ok(requests.every((r) => !r.url.includes('sk_')));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('client errors for mapped missing keys are sanitized and issue no upstream request', async () => {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    REVENUECAT_API_KEY: globalKey,
    REVENUECAT_PROJECT_KEY_ENV_JSON: mapping,
    REVENUECAT_PROJECT_KEY_AWARE: undefined,
  })) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const { getProject } = await import('./full-client.js');
    await assert.rejects(getProject('proja2cc4776'), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch((error as Error).message, /sk_/);
      assert.doesNotMatch((error as Error).message, /global|aware_synthetic/);
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('client rejects malformed project mapping before issuing an upstream request', async () => {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    REVENUECAT_API_KEY: globalKey,
    REVENUECAT_PROJECT_KEY_ENV_JSON: '{',
  })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const { getProject } = await import('./full-client.js');
    await assert.rejects(getProject('proja2cc4776'), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch((error as Error).message, /sk_|globalKey/);
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
