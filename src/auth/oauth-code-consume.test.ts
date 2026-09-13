import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeAuthCode, type DurableAuthCodeStore } from './oauth-tokens.js';

const CODE = 'a'.repeat(64);
const NOW = 1_700_000_000_000;
const document = {
  clientId: 'client-synthetic',
  redirectUri: 'https://client.example.test/callback',
  scope: 'mcp',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256' as const,
  expiresAt: NOW + 60_000,
};

function durable(overrides: Partial<DurableAuthCodeStore> = {}): DurableAuthCodeStore {
  return {
    isConfigured: () => true,
    read: async () => ({ doc: document, etag: 'etag-1' }),
    delete: async () => ({ ok: true, status: 204 }),
    now: () => NOW,
    ...overrides,
  };
}

test('durable auth-code consume permits exactly one winner when two readers race', async () => {
  let deletes = 0;
  const store = durable({
    delete: async (_container, _partitionKey, _id, ifMatch) => {
      assert.equal(ifMatch, 'etag-1');
      deletes += 1;
      return deletes === 1 ? { ok: true, status: 204 } : { ok: false, status: 412 };
    },
  });
  const [first, second] = await Promise.all([consumeAuthCode(CODE, store), consumeAuthCode(CODE, store)]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(deletes, 2);
});

test('durable auth-code consume fails closed for missing and conditional-delete conflicts', async () => {
  for (const status of [404, 412]) {
    assert.equal(
      await consumeAuthCode(CODE, durable({ delete: async () => ({ ok: false, status }) })),
      null,
      `status ${status} must not consume or return the code`,
    );
  }
});

test('durable auth-code consume fails closed when delete times out or errors', async () => {
  assert.equal(
    await consumeAuthCode(CODE, durable({ delete: async () => { throw new Error('synthetic timeout'); } })),
    null,
  );
});

test('durable auth-code consume requires a read etag before attempting deletion', async () => {
  let deletes = 0;
  const store = durable({
    read: async () => ({ doc: document, etag: null }),
    delete: async () => { deletes += 1; return { ok: true, status: 204 }; },
  });
  assert.equal(await consumeAuthCode(CODE, store), null);
  assert.equal(deletes, 0);
});

test('expired or malformed-expiry durable code is rejected without a delete attempt', async () => {
  let deletes = 0;
  for (const expiresAt of [NOW - 1, NOW, 'not-a-time']) {
    const store = durable({
      read: async () => ({ doc: { ...document, expiresAt }, etag: 'etag-1' }),
      delete: async () => { deletes += 1; return { ok: true, status: 204 }; },
    });
    assert.equal(await consumeAuthCode(CODE, store), null);
  }
  assert.equal(deletes, 0);
});

test('malformed auth code never invokes durable storage', async () => {
  let configuredCalls = 0;
  const store = durable({
    isConfigured: () => { configuredCalls += 1; return true; },
    read: async () => { throw new Error('must not read malformed code'); },
  });
  assert.equal(await consumeAuthCode('../not-a-code', store), null);
  assert.equal(configuredCalls, 0);
});

test('durable auth-code result retains existing scope, PKCE, and elevated-agent fields only after deletion succeeds', async () => {
  const result = await consumeAuthCode(CODE, durable({
    read: async () => ({ doc: { ...document, elevatedAgent: 'cto' }, etag: 'etag-1' }),
  }));
  assert.deepEqual(result, { ...document, elevatedAgent: 'cto' });
});
