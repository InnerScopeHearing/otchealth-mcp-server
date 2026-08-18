/**
 * Tests for Hyperagent refresh-token rotation.
 *
 * These pin the behaviours that the in-memory implementation got wrong. Hyperagent's refresh tokens
 * are single-use, so the failure these guard against is not "a request errors" — it is a consumed
 * token being presented again, which under reuse detection can revoke the whole family and cost a
 * fresh human browser consent. Every test below is a race or a persistence ordering, because those
 * are the only ways that happens.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BOOT = 'bootstrap-refresh-token';

// Same preamble as the xero client tests: loadEnv() validates the whole env, so its required vars
// must exist before the module under test is imported and transitively calls it.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
    N8N_WEBHOOK_SECRET: 'x'.repeat(32),
    HYPERAGENT_CLIENT_ID: 'client_abc',
    HYPERAGENT_REFRESH_TOKEN: BOOT,
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const {
  __resetHyperagentTokenLockForTests,
  bootstrapHash,
  getAccessToken,
} = await import('./token-store.js');
type HyperagentTokenDoc = import('./token-store.js').HyperagentTokenDoc;
type TokenDeps = import('./token-store.js').TokenDeps;

const B_HASH = bootstrapHash(BOOT);

function setEnv(): void {
  process.env.HYPERAGENT_CLIENT_ID = 'client_abc';
  process.env.HYPERAGENT_REFRESH_TOKEN = BOOT;
  delete process.env.HYPERAGENT_CLIENT_SECRET;
}

function liveDoc(over: Partial<HyperagentTokenDoc> = {}): HyperagentTokenDoc {
  return {
    id: 'hyperagent-oauth-token',
    kind: 'hyperagent-oauth',
    status: 'live',
    bootstrapHash: B_HASH,
    refreshToken: 'stored-refresh-1',
    accessToken: 'stored-access-1',
    expiresAt: Date.now() + 10 * 60_000,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

/** A fake token endpoint that records every refresh_token it is presented with. */
function fakeFetch(
  responses: Array<{ status: number; body: unknown }>,
  seen: string[],
): typeof fetch {
  let i = 0;
  return (async (_url: string, init: { body: URLSearchParams }) => {
    seen.push(String(init.body.get('refresh_token')));
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  }) as unknown as typeof fetch;
}

function deps(over: Partial<TokenDeps> = {}): TokenDeps {
  return {
    fetchImpl: fakeFetch([{ status: 200, body: {} }], []),
    read: async () => null,
    replace: async () => ({ status: 200, ok: true, body: null, etag: '"e2"' }),
    create: async () => ({ status: 201, ok: true, body: null, etag: '"e1"' }),
    stateConfigured: () => true,
    ...over,
  };
}

test.beforeEach(() => {
  __resetHyperagentTokenLockForTests();
  setEnv();
});

// ------------------------------------------------------------------ no needless rotation

test('a still-valid stored token is reused, so no refresh and no rotation happens', async () => {
  const seen: string[] = [];
  const token = await getAccessToken({
    deps: deps({
      read: async () => ({ doc: liveDoc(), etag: '"e1"' }),
      fetchImpl: fakeFetch([{ status: 200, body: {} }], seen),
      replace: async () => assert.fail('must not persist when the cached token is still valid'),
    }),
  });
  assert.equal(token, 'stored-access-1');
  assert.deepEqual(seen, [], 'the token endpoint must not be called at all');
});

test('a token inside the expiry skew IS refreshed, so it cannot expire mid-call', async () => {
  const seen: string[] = [];
  // 30s of life left, inside the 60s skew.
  const token = await getAccessToken({
    deps: deps({
      read: async () => ({ doc: liveDoc({ expiresAt: Date.now() + 30_000 }), etag: '"e1"' }),
      fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'fresh', refresh_token: 'r2', expires_in: 900 } }], seen),
    }),
  });
  assert.equal(token, 'fresh');
  assert.deepEqual(seen, ['stored-refresh-1'], 'refresh must use the STORED chain, not the bootstrap');
});

// ------------------------------------------------------------------ persist before use

test('the rotated refresh token is PERSISTED before the access token is returned', async () => {
  const persisted: HyperagentTokenDoc[] = [];
  const token = await getAccessToken({
    deps: deps({
      read: async () => ({ doc: liveDoc({ expiresAt: Date.now() - 1 }), etag: '"e1"' }),
      fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 900 } }], []),
      replace: async (_c, _p, _i, doc) => {
        persisted.push(doc as HyperagentTokenDoc);
        return { status: 200, ok: true, body: null, etag: '"e2"' };
      },
    }),
  });
  assert.equal(token, 'a2');
  assert.equal(persisted.length, 1, 'exactly one persist');
  assert.equal(persisted[0].refreshToken, 'r2', 'the NEW refresh token must be what was stored');
});

test('a failed persist does NOT return the token, since the next caller would reuse a spent one', async () => {
  await assert.rejects(
    getAccessToken({
      deps: deps({
        read: async () => ({ doc: liveDoc({ expiresAt: Date.now() - 1 }), etag: '"e1"' }),
        fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 900 } }], []),
        replace: async () => ({ status: 500, ok: false, body: null, etag: null }),
      }),
    }),
    /NOT returning an unpersisted chain/,
  );
});

// ------------------------------------------------------------------ the cross-replica race

test('a 412 loser ADOPTS the winner chain and never persists its own fork', async () => {
  let reads = 0;
  const writes: HyperagentTokenDoc[] = [];
  const token = await getAccessToken({
    deps: deps({
      read: async () => {
        reads += 1;
        // First read: our stale view. Second read (adoptWinner): the winner's fresh chain.
        return reads === 1
          ? { doc: liveDoc({ expiresAt: Date.now() - 1 }), etag: '"stale"' }
          : { doc: liveDoc({ accessToken: 'winner-access', expiresAt: Date.now() + 600_000 }), etag: '"winner"' };
      },
      fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'mine', refresh_token: 'r-mine', expires_in: 900 } }], []),
      replace: async (_c, _p, _i, doc) => {
        writes.push(doc as HyperagentTokenDoc);
        return { status: 412, ok: false, body: null, etag: null };
      },
    }),
  });
  assert.equal(token, 'winner-access', 'the loser must use the winner token, not its own');
  assert.equal(writes.length, 1, 'the loser attempted one CAS and then stopped');
});

test('concurrent callers in ONE replica serialize: the second reuses the first result', async () => {
  const seen: string[] = [];
  let stored: { doc: HyperagentTokenDoc; etag: string } | null = {
    doc: liveDoc({ expiresAt: Date.now() - 1 }),
    etag: '"e1"',
  };
  const d = deps({
    read: async () => stored,
    fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 900 } }], seen),
    replace: async (_c, _p, _i, doc) => {
      stored = { doc: doc as HyperagentTokenDoc, etag: '"e2"' };
      return { status: 200, ok: true, body: null, etag: '"e2"' };
    },
  });
  const [a, b] = await Promise.all([getAccessToken({ deps: d }), getAccessToken({ deps: d })]);
  assert.equal(a, 'a2');
  assert.equal(b, 'a2');
  assert.equal(seen.length, 1, 'the in-process mutex must collapse this to ONE refresh, not two');
});

// ------------------------------------------------------------------ dead chain / re-consent

test('invalid_grant marks the chain dead and asks for consent, naming the human step', async () => {
  await assert.rejects(
    getAccessToken({
      deps: deps({
        read: async () => ({ doc: liveDoc({ expiresAt: Date.now() - 1 }), etag: '"e1"' }),
        fetchImpl: fakeFetch([{ status: 400, body: { error: 'invalid_grant' } }], []),
      }),
    }),
    (e: Error) => e.name === 'HyperagentNeedsConsentError' && /hyperagent-refresh-token secret/.test(e.message),
  );
});

test('invalid_grant does NOT dead-mark when a concurrent replica already rotated a live chain', async () => {
  let reads = 0;
  const token = await getAccessToken({
    deps: deps({
      read: async () => {
        reads += 1;
        return reads === 1
          ? { doc: liveDoc({ expiresAt: Date.now() - 1 }), etag: '"stale"' }
          : { doc: liveDoc({ accessToken: 'winner', expiresAt: Date.now() + 600_000 }), etag: '"w"' };
      },
      fetchImpl: fakeFetch([{ status: 400, body: { error: 'invalid_grant' } }], []),
      replace: async () => assert.fail('must not write a tombstone over a live winner'),
    }),
  });
  assert.equal(token, 'winner');
});

test('a dead doc from an OLDER consent family does not block: a fresh consent supersedes it', async () => {
  const seen: string[] = [];
  const token = await getAccessToken({
    deps: deps({
      // Dead, but stamped with a DIFFERENT bootstrap hash -> a new consent has since been stored.
      read: async () => ({ doc: liveDoc({ status: 'dead', bootstrapHash: 'old-family-hash' }), etag: '"e1"' }),
      fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'a-new', refresh_token: 'r-new', expires_in: 900 } }], seen),
    }),
  });
  assert.equal(token, 'a-new');
  assert.deepEqual(seen, [BOOT], 'a new family must refresh from the BOOTSTRAP, not the dead chain');
});

test('a dead doc in the SAME family blocks immediately without touching the network', async () => {
  const seen: string[] = [];
  await assert.rejects(
    getAccessToken({
      deps: deps({
        read: async () => ({ doc: liveDoc({ status: 'dead', deadReason: 'invalid_grant (as returned by Hyperagent)' }), etag: '"e1"' }),
        fetchImpl: fakeFetch([{ status: 200, body: {} }], seen),
      }),
    }),
    (e: Error) => e.name === 'HyperagentNeedsConsentError',
  );
  assert.deepEqual(seen, [], 'a known-dead chain must not be presented again');
});

// ------------------------------------------------------------------ fail closed

test('with no shared state store the broker REFUSES rather than rotating unsynchronized', async () => {
  const seen: string[] = [];
  await assert.rejects(
    getAccessToken({ deps: deps({ stateConfigured: () => false, fetchImpl: fakeFetch([{ status: 200, body: {} }], seen) }) }),
    /shared agent-state store is not configured/,
  );
  assert.deepEqual(seen, [], 'refusing must happen BEFORE any token is presented');
});

// NOT UNIT-TESTED HERE, deliberately, rather than asserted misleadingly: the "no credentials
// configured" path. loadEnv() memoises on first call (`if (cached) return cached`), so deleting
// HYPERAGENT_CLIENT_ID after import does not change what this module reads — a test that tried it
// passed for the wrong reason or failed confusingly. The behaviour is real and is covered where it
// is observable: tools.ts gates every handler on hyperagentConfigured() and returns
// `mode: "unconfigured"`, which was verified live against the production gateway on 2026-08-18 (all
// five hyperagent_* tools, HTTP 200, ok:false).

test('first use with no stored doc CREATEs from the bootstrap token', async () => {
  const seen: string[] = [];
  const created: HyperagentTokenDoc[] = [];
  const token = await getAccessToken({
    deps: deps({
      read: async () => null,
      fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'a1', refresh_token: 'r1', expires_in: 900 } }], seen),
      create: async (_c, _p, doc) => {
        created.push(doc as HyperagentTokenDoc);
        return { status: 201, ok: true, body: null, etag: '"e1"' };
      },
      replace: async () => assert.fail('first use must CREATE, not REPLACE'),
    }),
  });
  assert.equal(token, 'a1');
  assert.deepEqual(seen, [BOOT]);
  assert.equal(created[0].refreshToken, 'r1');
});

test('a provider that stops rotating is fine: the current chain is carried forward', async () => {
  const persisted: HyperagentTokenDoc[] = [];
  const token = await getAccessToken({
    deps: deps({
      read: async () => ({ doc: liveDoc({ expiresAt: Date.now() - 1 }), etag: '"e1"' }),
      // No refresh_token echoed back -- a non-rotating provider.
      fetchImpl: fakeFetch([{ status: 200, body: { access_token: 'a2', expires_in: 900 } }], []),
      replace: async (_c, _p, _i, doc) => {
        persisted.push(doc as HyperagentTokenDoc);
        return { status: 200, ok: true, body: null, etag: '"e2"' };
      },
    }),
  });
  assert.equal(token, 'a2');
  assert.equal(persisted[0].refreshToken, 'stored-refresh-1', 'keep the existing chain rather than blanking it');
});
