import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEYGEN_TOKEN_DOC_ID,
  buildHeyGenPairingDoc,
  decryptHeyGenTokenState,
  type HeyGenBrokerDeps,
  type HeyGenPairingDoc,
  type HeyGenTokenDoc,
} from '../tools/heygen/broker.js';
import { handleHeyGenPairing } from './heygen-pairing.js';

const SECRET = 'pairing-test-signing-secret';
const PAIR_ID = Buffer.alloc(32, 11).toString('base64url');

function header(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

interface Stored {
  doc: Record<string, unknown>;
  etag: string;
}

function pairingDeps(options: { signingSecret?: string } = {}): {
  deps: HeyGenBrokerDeps;
  store: Map<string, Stored>;
  events: string[];
} {
  const events: string[] = [];
  const store = new Map<string, Stored>();
  store.set(PAIR_ID, { doc: buildHeyGenPairingDoc(PAIR_ID, 1_000_000), etag: 'E1' });
  let etagN = 1;
  const deps: HeyGenBrokerDeps = {
    now: () => 1_000_001,
    randomBytes: (size) => Buffer.alloc(size, 5),
    signingSecret: () => options.signingSecret ?? SECRET,
    fetchImpl: (async (url: string | URL) => {
      events.push(`fetch:${new URL(String(url)).pathname}`);
      return new Response(
        JSON.stringify({
          data: {
            username: 'paired-user',
            billing_type: 'subscription',
            subscription: { plan: 'team', credits: {} },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
    read: (async (_coll, pk, id) => {
      events.push(`read:${id}`);
      assert.equal(pk, id);
      const row = store.get(id);
      return row ? { doc: row.doc, etag: row.etag } : null;
    }) as HeyGenBrokerDeps['read'],
    create: (async (_coll, pk, doc) => {
      const id = String(doc.id);
      events.push(`create:${id}`);
      assert.equal(pk, id);
      if (store.has(id)) throw new Error('conflict');
      const etag = `E${++etagN}`;
      store.set(id, { doc, etag });
      return { ok: true, status: 201, body: doc, etag };
    }) as HeyGenBrokerDeps['create'],
    replace: (async (_coll, pk, id, doc, ifMatch) => {
      events.push(`replace:${id}:${String((doc as Record<string, unknown>).status)}`);
      assert.equal(pk, id);
      const prior = store.get(id);
      if (!prior || prior.etag !== ifMatch) {
        return { ok: false, status: 412, body: null, etag: null };
      }
      const etag = `E${++etagN}`;
      store.set(id, { doc, etag });
      return { ok: true, status: 200, body: doc, etag };
    }) as HeyGenBrokerDeps['replace'],
  };
  return { deps, store, events };
}

test('pair endpoint core claims before parsing, recursively rejects api_key, and leaves the id consumed', async () => {
  const { deps, store, events } = pairingDeps();
  const sensitive = 'API-KEY-MUST-NOT-ECHO';
  await assert.rejects(
    () =>
      handleHeyGenPairing(
        PAIR_ID,
        header({ oauth: { access_token: 'at', refresh_token: 'rt', nested: { api_key: sensitive } } }),
        deps,
      ),
    (error: Error) => /API-key credentials are not accepted/.test(error.message) && !error.message.includes(sensitive),
  );
  assert.deepEqual(events.slice(0, 2), [
    `read:${PAIR_ID}`,
    `replace:${PAIR_ID}:claiming`,
  ]);
  assert.ok(!events.some((event) => event.startsWith('fetch:')), 'invalid credentials must not reach HeyGen');
  assert.equal((store.get(PAIR_ID)!.doc as HeyGenPairingDoc).status, 'failed');
  await assert.rejects(() => handleHeyGenPairing(PAIR_ID, header({}), deps), /missing, expired, or already used/);
});

test('missing signing secret is refused only after the pair has been atomically consumed', async () => {
  const { deps, store, events } = pairingDeps({ signingSecret: '' });
  await assert.rejects(
    () => handleHeyGenPairing(PAIR_ID, header({ oauth: { access_token: 'at', refresh_token: 'rt' } }), deps),
    /OAUTH_TOKEN_SIGNING_SECRET/,
  );
  assert.deepEqual(events.slice(0, 2), [`read:${PAIR_ID}`, `replace:${PAIR_ID}:claiming`]);
  assert.equal((store.get(PAIR_ID)!.doc as HeyGenPairingDoc).status, 'failed');
  assert.equal(store.has(HEYGEN_TOKEN_DOC_ID), false);
});

test('successful pair verifies subscription, stores ciphertext only with ttl:-1, and is single-use', async () => {
  const { deps, store, events } = pairingDeps();
  const access = 'PAIR-ACCESS-SENSITIVE';
  const refresh = 'PAIR-REFRESH-SENSITIVE';
  const result = await handleHeyGenPairing(
    PAIR_ID,
    header({
      oauth: {
        access_token: access,
        refresh_token: refresh,
        expires_at: '2030-01-01T00:00:00Z',
        scope: 'openid profile email',
        token_type: 'Bearer',
      },
    }),
    deps,
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'paired');
  assert.ok(!JSON.stringify(result).includes(access));
  assert.ok(!JSON.stringify(result).includes(refresh));

  assert.deepEqual(events.slice(0, 3), [
    `read:${PAIR_ID}`,
    `replace:${PAIR_ID}:claiming`,
    'fetch:/v3/users/me',
  ]);
  assert.equal((store.get(PAIR_ID)!.doc as HeyGenPairingDoc).status, 'used');
  const persisted = store.get(HEYGEN_TOKEN_DOC_ID)!.doc as HeyGenTokenDoc;
  assert.equal(persisted.ttl, -1);
  assert.equal(persisted.cacheScope, HEYGEN_TOKEN_DOC_ID);
  assert.equal(Object.hasOwn(persisted, 'username'), false);
  assert.equal(Object.hasOwn(persisted, 'subscription'), false);
  assert.equal(Object.hasOwn(persisted, 'billingType'), false);
  const serialized = JSON.stringify(persisted);
  assert.ok(!serialized.includes(access));
  assert.ok(!serialized.includes(refresh));
  const state = decryptHeyGenTokenState(
    {
      version: persisted.version,
      ciphertext: persisted.ciphertext,
      iv: persisted.iv,
      tag: persisted.tag,
    },
    SECRET,
  );
  assert.equal(state.accessToken, access);
  assert.equal(state.refreshToken, refresh);

  await assert.rejects(
    () => handleHeyGenPairing(PAIR_ID, header({ oauth: { access_token: 'other', refresh_token: 'other' } }), deps),
    /missing, expired, or already used/,
  );
});

test('two concurrent consumers cannot both claim the same pair id', async () => {
  const { deps, events } = pairingDeps();
  const credentials = header({ oauth: { access_token: 'at', refresh_token: 'rt' } });
  const outcomes = await Promise.allSettled([
    handleHeyGenPairing(PAIR_ID, credentials, deps),
    handleHeyGenPairing(PAIR_ID, credentials, deps),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(events.filter((event) => event === 'fetch:/v3/users/me').length, 1);
  assert.equal(events.filter((event) => event === `create:${HEYGEN_TOKEN_DOC_ID}`).length, 1);
});

test('non-subscription verification prevents token persistence and never echoes an upstream body', async () => {
  const { deps, store, events } = pairingDeps();
  const leaked = 'UPSTREAM-SENSITIVE-BODY';
  deps.fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        data: {
          billing_type: 'wallet',
          wallet: { remaining_balance: 1 },
          leaked,
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  await assert.rejects(
    () => handleHeyGenPairing(PAIR_ID, header({ oauth: { access_token: 'at', refresh_token: 'rt' } }), deps),
    (error: Error) => /active subscription/.test(error.message) && !error.message.includes(leaked),
  );
  assert.equal(store.has(HEYGEN_TOKEN_DOC_ID), false);
  assert.ok(!events.some((event) => event === `create:${HEYGEN_TOKEN_DOC_ID}`));
  assert.equal((store.get(PAIR_ID)!.doc as HeyGenPairingDoc).status, 'failed');
});
