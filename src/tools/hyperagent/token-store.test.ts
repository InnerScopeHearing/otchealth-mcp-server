import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapHash, getAccessToken } from './token-store.js';
import type { HyperagentTokenDoc, TokenDeps } from './token-store.js';

const BOOT = 'synthetic-bootstrap-refresh';
const NOW = 1_800_000_000_000;
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32), ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
    N8N_WEBHOOK_SECRET: 'x'.repeat(32), HYPERAGENT_CLIENT_ID: 'synthetic-client',
    HYPERAGENT_REFRESH_TOKEN: BOOT,
  };
  for (const [key, value] of Object.entries(required)) process.env[key] = value;
});

function live(over: Partial<HyperagentTokenDoc> = {}): HyperagentTokenDoc {
  return { id: 'hyperagent-oauth-token', kind: 'hyperagent-oauth', status: 'live',
    bootstrapHash: bootstrapHash(BOOT), refreshToken: 'synthetic-refresh-1',
    accessToken: 'synthetic-access-1', expiresAt: NOW + 600_000,
    updatedAt: new Date(NOW).toISOString(), ...over };
}
function claim(over: Partial<HyperagentTokenDoc> = {}): HyperagentTokenDoc {
  return live({ status: 'dead', accessToken: '', refreshToken: '', expiresAt: 0,
    rotationClaim: { id: 'synthetic-owner', startedAt: NOW }, ...over });
}
function response(status = 200, body: unknown = {
  access_token: 'synthetic-access-2', refresh_token: 'synthetic-refresh-2', expires_in: 900,
}): Response { return new Response(JSON.stringify(body), { status }); }

/** No process mutex. Independent deps instances share only a CAS store, like two replicas. */
function sharedStore(initial: HyperagentTokenDoc | null = live({ expiresAt: NOW - 1 })) {
  let state = initial ? { doc: structuredClone(initial), etag: 'e1' } : null;
  let version = 1;
  const writes: HyperagentTokenDoc[] = [];
  const submitted: string[] = [];
  const save = (doc: Record<string, unknown>) => {
    state = { doc: structuredClone(doc) as HyperagentTokenDoc, etag: `e${++version}` };
    writes.push(structuredClone(state.doc));
    return { status: 200, ok: true, body: state.doc, etag: state.etag };
  };
  const base: TokenDeps = {
    stateConfigured: () => true, now: () => NOW, wait: async () => { await Promise.resolve(); },
    read: async () => structuredClone(state),
    replace: async (_coll, _pk, _id, doc, etag) => {
      assert.ok(etag, 'every replacement must be conditional');
      return state?.etag === etag ? save(doc) : { status: 412, ok: false, body: null, etag: null };
    },
    create: async (_coll, _pk, doc) => {
      if (state) throw new Error('synthetic duplicate');
      return { ...save(doc), status: 201 };
    },
    fetchImpl: (async (_url, init) => {
      assert.equal(state?.doc.status, 'dead', 'claim must exist BEFORE endpoint submission');
      assert.ok(state?.doc.rotationClaim);
      assert.equal(state?.doc.refreshToken, '', 'claimed token is no longer reusable from the store');
      submitted.push(String((init!.body as URLSearchParams).get('refresh_token')));
      return response();
    }) as typeof fetch,
  };
  return { base, writes, submitted, snapshot: () => structuredClone(state), save };
}

test('unexpired stored token is reused without claim or endpoint request', async () => {
  const store = sharedStore(live());
  assert.equal(await getAccessToken({ deps: store.base }), 'synthetic-access-1');
  assert.equal(store.writes.length, 0); assert.equal(store.submitted.length, 0);
});

test('expiry skew claims first, submits stored chain once, and persists before return', async () => {
  const store = sharedStore(live({ expiresAt: NOW + 30_000 }));
  assert.equal(await getAccessToken({ deps: store.base }), 'synthetic-access-2');
  assert.deepEqual(store.submitted, ['synthetic-refresh-1']);
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes[0].status, 'dead');
  assert.equal(store.snapshot()?.doc.refreshToken, 'synthetic-refresh-2');
  assert.equal(store.snapshot()?.doc.rotationClaim, undefined);
});

test('rejected but unexpired access token forces one refresh of that exact shared chain', async () => {
  const store = sharedStore(live());
  assert.equal(await getAccessToken({ deps: store.base, rejectedAccessToken: 'synthetic-access-1' }), 'synthetic-access-2');
  assert.equal(store.submitted.length, 1);
});

test('401 from an older access token adopts already changed shared token without rotation', async () => {
  const store = sharedStore(live({ accessToken: 'synthetic-newer-access' }));
  assert.equal(await getAccessToken({ deps: store.base, rejectedAccessToken: 'synthetic-access-1' }), 'synthetic-newer-access');
  assert.equal(store.submitted.length, 0); assert.equal(store.writes.length, 0);
});

for (const firstUse of [false, true]) {
  test(`two independent replicas ${firstUse ? 'creating first claim' : 'racing on same ETag'} submit single-use token only once`, async () => {
    const store = sharedStore(firstUse ? null : live({ expiresAt: NOW - 1 }));
    // Distinct dependency objects, with no shared module-local lock or promise gate.
    const [a, b] = await Promise.all([
      getAccessToken({ deps: { ...store.base } }), getAccessToken({ deps: { ...store.base } }),
    ]);
    assert.equal(a, 'synthetic-access-2'); assert.equal(b, a);
    assert.deepEqual(store.submitted, [firstUse ? BOOT : 'synthetic-refresh-1']);
    assert.equal(store.writes.filter(doc => doc.rotationClaim).length, 1);
  });
}

test('concurrent 401 repairs of same rejected access token adopt one rotated result', async () => {
  const store = sharedStore(live());
  const results = await Promise.all([1, 2].map(() => getAccessToken({ deps: { ...store.base }, rejectedAccessToken: 'synthetic-access-1' })));
  assert.deepEqual(results, ['synthetic-access-2', 'synthetic-access-2']);
  assert.equal(store.submitted.length, 1);
});

test('a fresh same-family lease is waited on, never acquired twice', async () => {
  const store = sharedStore(claim());
  let waits = 0;
  const token = await getAccessToken({ deps: { ...store.base, wait: async () => {
    waits += 1; assert.equal(store.snapshot()?.doc.rotationClaim?.id, 'synthetic-owner');
    store.save(live({ accessToken: 'synthetic-winner' }));
  } } });
  assert.equal(token, 'synthetic-winner'); assert.equal(waits, 1); assert.equal(store.submitted.length, 0);
});

test('an abandoned or malformed lease is never stolen or its refresh token replayed', async () => {
  for (const startedAt of [NOW - 45_000, Number.NaN]) {
    const store = sharedStore(claim({ rotationClaim: { id: 'previous-owner', startedAt } }));
    await assert.rejects(getAccessToken({ deps: store.base }), /previous refresh outcome is unknown/);
    assert.equal(store.submitted.length, 0); assert.equal(store.writes.length, 0);
  }
});

test('waiting on an active claim is bounded and leaves its owner untouched', async () => {
  const store = sharedStore(claim()); let waits = 0;
  await assert.rejects(getAccessToken({ deps: { ...store.base, wait: async () => { waits += 1; } } }), { name: 'HyperagentRefreshPendingError' });
  assert.equal(waits, 200); assert.equal(store.writes.length, 0); assert.equal(store.submitted.length, 0);
});

test('claim wait deadline includes store-read latency instead of only counting sleeps', async () => {
  const store = sharedStore(claim()); let clock = NOW; let reads = 0;
  await assert.rejects(getAccessToken({ deps: { ...store.base, now: () => clock,
    read: async (...args) => { reads += 1; clock += 4_000; return store.base.read(...args); },
    wait: async ms => { clock += ms; },
  } }), { name: 'HyperagentRefreshPendingError' });
  assert.equal(reads, 5); assert.equal(store.submitted.length, 0); assert.equal(store.writes.length, 0);
});

test('a hung shared-store read times out without submitting a credential', { timeout: 7_000 }, async () => {
  const store = sharedStore();
  await assert.rejects(getAccessToken({ deps: { ...store.base, read: async () => new Promise(() => {}) } }), /shared token state unavailable/);
  assert.equal(store.submitted.length, 0);
});

test('ambiguous claim write never submits, even if that write actually committed', async () => {
  for (const firstUse of [false, true]) {
    const store = sharedStore(firstUse ? null : undefined);
    const failing = async (...args: Parameters<TokenDeps['replace']>) => {
      await store.base.replace(...args); throw Error('synthetic-store-sensitive-error');
    };
    await assert.rejects(getAccessToken({ deps: { ...store.base,
      replace: failing,
      create: async (...args) => { await store.base.create(...args); throw Error('synthetic-sensitive'); },
    } }), error => error instanceof Error && /claim outcome unknown/.test(error.message) && !error.message.includes('synthetic-sensitive'));
    assert.equal(store.submitted.length, 0); assert.ok(store.snapshot()?.doc.rotationClaim);
  }
});

test('uncertain endpoint failure quarantines the claim and cannot reuse the token later', async () => {
  const store = sharedStore(); let calls = 0;
  const failing: TokenDeps = { ...store.base, fetchImpl: (async () => { calls += 1; throw Error('synthetic-secret-echo'); }) as typeof fetch };
  await assert.rejects(getAccessToken({ deps: failing }), error => error instanceof Error && /outcome is unknown/.test(error.message) && !error.message.includes('synthetic-secret'));
  assert.equal(store.snapshot()?.doc.refreshToken, '');
  await assert.rejects(getAccessToken({ deps: { ...failing, now: () => NOW + 46_000 } }), /previous refresh outcome is unknown/);
  assert.equal(calls, 1);
});

test('HTTP errors, malformed success and missing/unchanged rotation never restore submitted token', async () => {
  for (const makeResponse of [
    () => response(503, { error: 'synthetic-sensitive' }),
    () => new Response('{malformed', { status: 200 }),
    () => response(200, { access_token: 'synthetic-a2' }),
    () => response(200, { access_token: 'synthetic-a2', refresh_token: 'synthetic-refresh-1' }),
  ]) {
    const store = sharedStore();
    await assert.rejects(getAccessToken({ deps: { ...store.base, fetchImpl: (async () => makeResponse()) as typeof fetch } }), /outcome is unknown/);
    assert.ok(store.snapshot()?.doc.rotationClaim); assert.equal(store.snapshot()?.doc.refreshToken, '');
  }
});

test('invalid_grant within expiry skew never adopts the same rejected token as its own winner', async () => {
  // The old adoptWinner accepted this unchanged token until hard expiry, masking invalid_grant.
  const store = sharedStore(live({ expiresAt: NOW + 30_000 })); let calls = 0;
  const d = { ...store.base, fetchImpl: (async () => { calls += 1; return response(400, { error: 'invalid_grant' }); }) as typeof fetch };
  await assert.rejects(getAccessToken({ deps: d }), /invalid_grant/);
  assert.equal(store.snapshot()?.doc.rotationClaim, undefined);
  await assert.rejects(getAccessToken({ deps: d }), /marked dead/);
  assert.equal(calls, 1);
});

test('failed final persist returns no unpersisted token and retains non-replayable claim', async () => {
  const store = sharedStore();
  const d: TokenDeps = { ...store.base, replace: async (...args) => args[3].status === 'live'
    ? { status: 500, ok: false, body: null, etag: null } : store.base.replace(...args) };
  await assert.rejects(getAccessToken({ deps: d }), /NOT returning an unpersisted chain/);
  await assert.rejects(getAccessToken({ deps: { ...d, now: () => NOW + 46_000 } }), /previous refresh outcome is unknown/);
  assert.equal(store.submitted.length, 1); assert.equal(store.snapshot()?.doc.refreshToken, '');
});

test('committed final persist with lost response is adopted on next call without replay', async () => {
  const store = sharedStore();
  await assert.rejects(getAccessToken({ deps: { ...store.base, replace: async (...args) => {
    const result = await store.base.replace(...args);
    if (args[3].status === 'live') throw Error('synthetic lost acknowledgement');
    return result;
  } } }), /persist outcome unknown/);
  assert.equal(await getAccessToken({ deps: store.base }), 'synthetic-access-2');
  assert.equal(store.submitted.length, 1);
});

test('lost final claim cannot overwrite a newer consent family or revive its tombstone', async () => {
  const store = sharedStore();
  await assert.rejects(getAccessToken({ deps: { ...store.base, fetchImpl: (async () => {
    store.save(live({ status: 'dead', bootstrapHash: 'newer-consent', refreshToken: '', accessToken: '' }));
    return response();
  }) as typeof fetch } }), /NOT returning an unpersisted chain/);
  assert.equal(store.snapshot()?.doc.bootstrapHash, 'newer-consent');
  assert.equal(store.snapshot()?.doc.status, 'dead');
});

test('a lost final claim adopts only a different persisted same-family access token', async () => {
  for (const changed of [false, true]) {
    const store = sharedStore();
    const result = getAccessToken({ deps: { ...store.base, fetchImpl: (async () => {
      store.save(live({ accessToken: changed ? 'synthetic-winner' : 'synthetic-access-1' }));
      return response();
    }) as typeof fetch } });
    if (changed) assert.equal(await result, 'synthetic-winner');
    else await assert.rejects(result, /NOT returning an unpersisted chain/);
    assert.equal(store.snapshot()?.doc.accessToken, changed ? 'synthetic-winner' : 'synthetic-access-1');
  }
});

test('fresh configured consent supersedes an older dead family with a new claimed bootstrap', async () => {
  const store = sharedStore(live({ status: 'dead', bootstrapHash: 'older-consent' }));
  assert.equal(await getAccessToken({ deps: store.base }), 'synthetic-access-2');
  assert.deepEqual(store.submitted, [BOOT]);
});

test('missing shared store, missing ETag or failed claim stops before token endpoint', async () => {
  const store = sharedStore();
  await assert.rejects(getAccessToken({ deps: { ...store.base, stateConfigured: () => false } }), /not configured/);
  await assert.rejects(getAccessToken({ deps: { ...store.base, read: async () => ({ doc: live({ expiresAt: NOW - 1 }), etag: null }) } }), /no ETag/);
  await assert.rejects(getAccessToken({ deps: { ...store.base, replace: async () => ({ status: 500, ok: false, body: null, etag: null }) } }), /claim not confirmed/);
  assert.equal(store.submitted.length, 0);
});
