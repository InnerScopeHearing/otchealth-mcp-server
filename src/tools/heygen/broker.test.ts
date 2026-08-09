import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEYGEN_API_BASE,
  HEYGEN_OAUTH_CLIENT_ID,
  HEYGEN_PAIR_TTL_SECONDS,
  HEYGEN_TOKEN_DOC_ID,
  HEYGEN_TOKEN_URL,
  buildHeyGenPairingDoc,
  buildHeyGenTokenDoc,
  containsApiKey,
  decryptHeyGenTokenState,
  encryptHeyGenTokenState,
  executeHeyGenRead,
  getHeyGenAccessToken,
  getHeyGenPairingStatus,
  newHeyGenPairId,
  parseOfficialCredentialsHeader,
  persistPairedHeyGenToken,
  tokenFamilyFingerprint,
  type HeyGenBrokerDeps,
  type HeyGenTokenDoc,
  type HeyGenTokenState,
} from './broker.js';

const SECRET = 'test-signing-secret-with-enough-entropy-for-hkdf';
const USER_RESPONSE = {
  data: {
    username: 'test-user',
    billing_type: 'subscription',
    subscription: { plan: 'team', credits: {} },
  },
};

const BASE_STATE: HeyGenTokenState = {
  accessToken: 'access-token-SENSITIVE',
  refreshToken: 'refresh-token-SENSITIVE',
  expiresAt: 2_000_000,
  scope: 'openid profile email',
  tokenType: 'Bearer',
};

function fixedRandom(byte = 7): (size: number) => Buffer {
  return (size) => Buffer.alloc(size, byte);
}

function tokenDoc(state: HeyGenTokenState, nowMs = 1_000_000): HeyGenTokenDoc {
  return buildHeyGenTokenDoc({
    state,
    signingSecret: SECRET,
    userResponse: USER_RESPONSE,
    nowMs,
    randomBytesImpl: fixedRandom(3),
  });
}

function baseDeps(overrides: Partial<HeyGenBrokerDeps> = {}): HeyGenBrokerDeps {
  return {
    fetchImpl: (async () => {
      throw new Error('unexpected network call');
    }) as typeof fetch,
    read: (async () => null) as HeyGenBrokerDeps['read'],
    create: (async () => ({ ok: true, status: 201, body: {}, etag: 'E1' })) as HeyGenBrokerDeps['create'],
    replace: (async () => ({ ok: true, status: 200, body: {}, etag: 'E2' })) as HeyGenBrokerDeps['replace'],
    now: () => 1_000_000,
    randomBytes: fixedRandom(),
    signingSecret: () => SECRET,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function officialHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

test('AES-256-GCM token envelope round-trips deterministically with an injected IV and refuses a wrong key', () => {
  const a = encryptHeyGenTokenState(BASE_STATE, SECRET, fixedRandom(9));
  const b = encryptHeyGenTokenState(BASE_STATE, SECRET, fixedRandom(9));
  assert.deepEqual(a, b, 'fixed test IV makes the encryption vector deterministic');
  assert.deepEqual(decryptHeyGenTokenState(a, SECRET), BASE_STATE);
  assert.throws(
    () => decryptHeyGenTokenState(a, 'wrong-signing-secret'),
    /could not be decrypted/,
  );
});

test('SAFETY-CRITICAL: persisted token doc is ciphertext-only, ttl:-1, and cacheScope equals fixed id', () => {
  const doc = tokenDoc(BASE_STATE);
  assert.equal(doc.id, HEYGEN_TOKEN_DOC_ID);
  assert.equal(doc.cacheScope, HEYGEN_TOKEN_DOC_ID);
  assert.equal(doc.ttl, -1);
  assert.equal(doc.status, 'live');
  assert.equal(doc.version, 1);
  const serialized = JSON.stringify(doc);
  assert.ok(!serialized.includes(BASE_STATE.accessToken));
  assert.ok(!serialized.includes(BASE_STATE.refreshToken));
  assert.ok(!Object.hasOwn(doc, 'accessToken'));
  assert.ok(!Object.hasOwn(doc, 'refreshToken'));
  assert.deepEqual(
    Object.keys(doc).sort(),
    [
      'cacheScope', 'ciphertext', 'familyFingerprint', 'id', 'iv', 'kind',
      'pairedAt', 'status', 'tag', 'ttl', 'updatedAt', 'version',
    ].sort(),
    'plaintext token document must contain only the encrypted envelope and durability/live metadata',
  );
  assert.deepEqual(
    decryptHeyGenTokenState(
      { version: doc.version, ciphertext: doc.ciphertext, iv: doc.iv, tag: doc.tag },
      SECRET,
    ),
    BASE_STATE,
  );
});

test('official credential parser accepts oauth plus the CLI user block, discards user data, and recursively rejects api_key', () => {
  const parsed = parseOfficialCredentialsHeader(
    officialHeader({
      oauth: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: '2030-01-02T03:04:05Z',
        scope: 'openid',
        token_type: 'Bearer',
      },
      user: {
        email: 'owner@example.test',
        first_name: 'Owner',
        last_name: 'Example',
        username: 'owner',
      },
    }),
  );
  assert.equal(parsed.accessToken, 'at');
  assert.equal(parsed.refreshToken, 'rt');
  assert.equal(parsed.expiresAt, Date.parse('2030-01-02T03:04:05Z'));
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['accessToken', 'expiresAt', 'refreshToken', 'scope', 'tokenType'].sort(),
    'friendly user metadata is accepted for official-file compatibility but discarded',
  );

  for (const bad of [
    { api_key: 'forbidden', oauth: { access_token: 'at', refresh_token: 'rt' } },
    { oauth: { access_token: 'at', refresh_token: 'rt', nested: { api_key: 'forbidden' } } },
    { oauth: { access_token: 'at' } },
    { oauth: { refresh_token: 'rt' } },
    { oauth: { access_token: 'at', refresh_token: 'rt' }, extra: true },
  ]) {
    assert.throws(() => parseOfficialCredentialsHeader(officialHeader(bad)));
  }
  assert.equal(containsApiKey({ a: [{ b: { API_KEY: 'x' } }] }), true);
  assert.equal(containsApiKey({ apiKey: 'not-the-official-key-name' }), false);
});

test('credential parse errors never echo credential JSON or token values', () => {
  const sensitive = 'VERY-SENSITIVE-TOKEN-VALUE';
  assert.throws(
    () => parseOfficialCredentialsHeader(officialHeader({ oauth: { access_token: sensitive } })),
    (error: Error) => !error.message.includes(sensitive) && !error.message.includes('access_token'),
  );
});

test('pair id uses exactly 32 random bytes and pairing doc expires in 15 minutes with cacheScope=id', async () => {
  let requested = 0;
  const id = newHeyGenPairId((size) => {
    requested = size;
    return Buffer.from(Array.from({ length: size }, (_, i) => i));
  });
  assert.equal(requested, 32);
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  const doc = buildHeyGenPairingDoc(id, 10_000);
  assert.equal(doc.id, id);
  assert.equal(doc.cacheScope, id);
  assert.equal(doc.ttl, HEYGEN_PAIR_TTL_SECONDS);
  assert.equal(Date.parse(doc.expiresAt) - Date.parse(doc.createdAt), 15 * 60 * 1000);

  const status = await getHeyGenPairingStatus(
    id,
    baseDeps({
      now: () => Date.parse(doc.expiresAt) + 1,
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
    }),
  );
  assert.equal(status.status, 'expired');
});

test('subscription guard prevents the target request for wallet, null subscription, and empty subscription accounts', async () => {
  for (const guardedUser of [
    { data: { billing_type: 'wallet', wallet: { remaining_balance: 5 } } },
    { data: { billing_type: 'subscription', subscription: null } },
    { data: { billing_type: 'subscription', subscription: {} } },
  ]) {
    const calls: string[] = [];
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        calls.push(new URL(String(url)).pathname);
        return jsonResponse(guardedUser);
      }) as typeof fetch,
    });
    await assert.rejects(() => executeHeyGenRead({ kind: 'videos' }, deps), /active subscription/);
    assert.deepEqual(calls, ['/v3/users/me'], 'target must not be called after guard refusal');
  }
});

test('account_get equivalent returns the guarded /v3/users/me response itself and performs no second request', async () => {
  const calls: string[] = [];
  const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
  const deps = baseDeps({
    read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
    fetchImpl: (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse(USER_RESPONSE);
    }) as typeof fetch,
  });
  assert.deepEqual(await executeHeyGenRead({ kind: 'account' }, deps), USER_RESPONSE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `${HEYGEN_API_BASE}/v3/users/me`);
});

test('each fixed data operation calls /v3/users/me immediately before its exact verified target route', async () => {
  const cases = [
    {
      operation: { kind: 'videos', limit: 7, token: 'next', folderId: 'folder', title: 'needle' } as const,
      target: '/v3/videos?limit=7&token=next&folder_id=folder&title=needle',
    },
    {
      operation: { kind: 'video', videoId: 'video_id-123' } as const,
      target: '/v3/videos/video_id-123',
    },
    {
      operation: { kind: 'styles', tag: 'cinematic', limit: 20, token: 'next' } as const,
      target: '/v3/video-agents/styles?tag=cinematic&limit=20&token=next',
    },
  ];
  for (const { operation, target } of cases) {
    const calls: string[] = [];
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        const parsed = new URL(String(url));
        calls.push(`${parsed.pathname}${parsed.search}`);
        return parsed.pathname === '/v3/users/me' ? jsonResponse(USER_RESPONSE) : jsonResponse({ data: [] });
      }) as typeof fetch,
    });
    await executeHeyGenRead(operation, deps);
    assert.deepEqual(calls, ['/v3/users/me', target]);
  }
});

test('video path input rejects slash and dot-segment ids before any target request', async () => {
  for (const videoId of ['../users/me', '..', '.', 'video/id', 'video%2Fid']) {
    const calls: string[] = [];
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse(USER_RESPONSE);
      }) as typeof fetch,
    });
    await assert.rejects(
      () => executeHeyGenRead({ kind: 'video', videoId }, deps),
      /video_id contains unsupported characters/,
    );
    assert.deepEqual(calls, ['/v3/users/me'], 'subscription guard may run, but the invalid target must not');
  }
});

test('safe re-pair replaces the fixed token doc only through Cosmos ETag', async () => {
  const old = tokenDoc(BASE_STATE);
  let replaceArgs: unknown[] | null = null;
  const nextState = { ...BASE_STATE, accessToken: 'new-access', refreshToken: 'new-refresh' };
  const deps = baseDeps({
    read: (async () => ({ doc: old, etag: 'OLD-ETAG' })) as HeyGenBrokerDeps['read'],
    create: (async () => {
      throw new Error('re-pair must never create over an existing token doc');
    }) as HeyGenBrokerDeps['create'],
    replace: (async (...args) => {
      replaceArgs = args;
      return { ok: true, status: 200, body: args[3] as Record<string, unknown>, etag: 'NEW-ETAG' };
    }) as HeyGenBrokerDeps['replace'],
  });
  const persisted = await persistPairedHeyGenToken(nextState, USER_RESPONSE, deps);
  assert.ok(replaceArgs);
  assert.equal(replaceArgs![1], HEYGEN_TOKEN_DOC_ID);
  assert.equal(replaceArgs![2], HEYGEN_TOKEN_DOC_ID);
  assert.equal(replaceArgs![4], 'OLD-ETAG');
  assert.equal(persisted.ttl, -1);
  assert.ok(!JSON.stringify(persisted).includes(nextState.accessToken));
});

test('90-second proactive margin refreshes a token before its actual expiry', async () => {
  const nearExpiry = tokenDoc({ ...BASE_STATE, expiresAt: 1_090_000 });
  let refreshCalls = 0;
  const deps = baseDeps({
    now: () => 1_000_000,
    read: (async () => ({ doc: nearExpiry, etag: 'E1' })) as HeyGenBrokerDeps['read'],
    fetchImpl: (async () => {
      refreshCalls += 1;
      return jsonResponse({ access_token: 'access-MARGIN', expires_in: 3600 });
    }) as typeof fetch,
  });
  assert.equal(await getHeyGenAccessToken({ deps }), 'access-MARGIN');
  assert.equal(refreshCalls, 1);
});

test('refresh form is exact, omitted refresh_token is retained, and encrypted chain persists before return', async () => {
  const expired = tokenDoc({ ...BASE_STATE, expiresAt: 1 });
  const events: string[] = [];
  let persisted: HeyGenTokenDoc | null = null;
  const deps = baseDeps({
    now: () => 1_000_000,
    read: (async () => ({ doc: expired, etag: 'E1' })) as HeyGenBrokerDeps['read'],
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      assert.equal(String(url), HEYGEN_TOKEN_URL);
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init?.body));
      assert.deepEqual([...form.entries()], [
        ['grant_type', 'refresh_token'],
        ['refresh_token', BASE_STATE.refreshToken],
        ['client_id', HEYGEN_OAUTH_CLIENT_ID],
      ]);
      events.push('refresh');
      return jsonResponse({ access_token: 'access-ROTATED', expires_in: 3600, token_type: 'Bearer' });
    }) as typeof fetch,
    replace: (async (_c, _pk, _id, next) => {
      events.push('persist');
      persisted = next as HeyGenTokenDoc;
      return { ok: true, status: 200, body: next, etag: 'E2' };
    }) as HeyGenBrokerDeps['replace'],
  });
  const access = await getHeyGenAccessToken({ deps });
  events.push('returned');
  assert.equal(access, 'access-ROTATED');
  assert.deepEqual(events, ['refresh', 'persist', 'returned']);
  assert.ok(persisted);
  const state = decryptHeyGenTokenState(
    {
      version: persisted!.version,
      ciphertext: persisted!.ciphertext,
      iv: persisted!.iv,
      tag: persisted!.tag,
    },
    SECRET,
  );
  assert.equal(state.refreshToken, BASE_STATE.refreshToken, 'RFC 6749: retain prior refresh token when omitted');
  assert.equal(state.accessToken, 'access-ROTATED');
  assert.ok(!JSON.stringify(persisted).includes('access-ROTATED'));
});

test('in-replica promise mutex coalesces concurrent proactive refreshes to one token grant', async () => {
  let doc = tokenDoc({ ...BASE_STATE, expiresAt: 1 });
  let etag = 'E1';
  let refreshCalls = 0;
  const deps = baseDeps({
    read: (async () => ({ doc, etag })) as HeyGenBrokerDeps['read'],
    fetchImpl: (async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ access_token: 'access-ONE', refresh_token: 'refresh-ONE', expires_in: 3600 });
    }) as typeof fetch,
    replace: (async (_c, _pk, _id, next) => {
      doc = next as HeyGenTokenDoc;
      etag = 'E2';
      return { ok: true, status: 200, body: next, etag };
    }) as HeyGenBrokerDeps['replace'],
  });
  const [a, b] = await Promise.all([
    getHeyGenAccessToken({ deps }),
    getHeyGenAccessToken({ deps }),
  ]);
  assert.deepEqual([a, b], ['access-ONE', 'access-ONE']);
  assert.equal(refreshCalls, 1);
});

test('ETag loser discards its rotated fork and adopts a fresh same-family winner', async () => {
  const expired = tokenDoc({ ...BASE_STATE, expiresAt: 1 });
  const winnerState = {
    ...BASE_STATE,
    accessToken: 'access-WINNER',
    refreshToken: 'refresh-WINNER',
    expiresAt: 5_000_000,
  };
  const winner = buildHeyGenTokenDoc({
    state: winnerState,
    signingSecret: SECRET,
    userResponse: USER_RESPONSE,
    nowMs: 1_000_000,
    familyFingerprint: expired.familyFingerprint,
    randomBytesImpl: fixedRandom(8),
  });
  let reads = 0;
  const deps = baseDeps({
    read: (async () => {
      reads += 1;
      return reads === 1 ? { doc: expired, etag: 'E1' } : { doc: winner, etag: 'E2' };
    }) as HeyGenBrokerDeps['read'],
    fetchImpl: (async () => jsonResponse({ access_token: 'access-LOSER', refresh_token: 'refresh-LOSER', expires_in: 3600 })) as typeof fetch,
    replace: (async () => ({ ok: false, status: 412, body: null, etag: null })) as HeyGenBrokerDeps['replace'],
  });
  assert.equal(await getHeyGenAccessToken({ deps }), 'access-WINNER');
  assert.equal(reads, 2);
});

test('a refresh-token rejection adopts a fresh same-family winner instead of returning the stale failure', async () => {
  const expired = tokenDoc({ ...BASE_STATE, expiresAt: 1 });
  const winner = buildHeyGenTokenDoc({
    state: { ...BASE_STATE, accessToken: 'access-WINNER-AFTER-REJECTION', expiresAt: 5_000_000 },
    signingSecret: SECRET,
    userResponse: USER_RESPONSE,
    familyFingerprint: expired.familyFingerprint,
    randomBytesImpl: fixedRandom(6),
  });
  let reads = 0;
  const deps = baseDeps({
    read: (async () => {
      reads += 1;
      return reads === 1 ? { doc: expired, etag: 'E1' } : { doc: winner, etag: 'E2' };
    }) as HeyGenBrokerDeps['read'],
    fetchImpl: (async () => jsonResponse({ error: 'invalid_grant', secret: 'never-surface' }, 400)) as typeof fetch,
  });
  assert.equal(await getHeyGenAccessToken({ deps }), 'access-WINNER-AFTER-REJECTION');
  assert.equal(reads, 2);
});

test('persist failure refuses to return an unpersisted rotated chain and redacts response token/body', async () => {
  const leaked = 'UPSTREAM-BODY-SECRET';
  const expired = tokenDoc({ ...BASE_STATE, expiresAt: 1 });
  const deps = baseDeps({
    read: (async () => ({ doc: expired, etag: 'E1' })) as HeyGenBrokerDeps['read'],
    fetchImpl: (async () => jsonResponse({ access_token: leaked, refresh_token: `refresh-${leaked}`, expires_in: 3600 })) as typeof fetch,
    replace: (async () => ({ ok: false, status: 500, body: { leaked }, etag: null })) as HeyGenBrokerDeps['replace'],
  });
  await assert.rejects(
    () => getHeyGenAccessToken({ deps }),
    (error: Error) =>
      /not returned/.test(error.message) &&
      !error.message.includes(leaked) &&
      !error.message.includes(BASE_STATE.refreshToken),
  );
});

test('one target 401 forces exactly one refresh and retries the complete /users/me -> target sequence once', async () => {
  let doc = tokenDoc({ ...BASE_STATE, accessToken: 'access-OLD', expiresAt: 0 });
  let etag = 'E1';
  const events: string[] = [];
  let targetCalls = 0;
  let refreshCalls = 0;
  const deps = baseDeps({
    read: (async () => ({ doc, etag })) as HeyGenBrokerDeps['read'],
    replace: (async (_c, _pk, _id, next) => {
      events.push('persist');
      doc = next as HeyGenTokenDoc;
      etag = 'E2';
      return { ok: true, status: 200, body: next, etag };
    }) as HeyGenBrokerDeps['replace'],
    fetchImpl: (async (url: string | URL) => {
      const parsed = new URL(String(url));
      if (String(url) === HEYGEN_TOKEN_URL) {
        refreshCalls += 1;
        events.push('refresh');
        return jsonResponse({ access_token: 'access-NEW', refresh_token: 'refresh-NEW', expires_in: 3600 });
      }
      if (parsed.pathname === '/v3/users/me') {
        events.push('me');
        return jsonResponse(USER_RESPONSE);
      }
      if (parsed.pathname === '/v3/videos') {
        targetCalls += 1;
        events.push('target');
        return targetCalls === 1 ? jsonResponse({ secret: 'do-not-surface' }, 401) : jsonResponse({ data: [{ id: 'v1' }] });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  });
  assert.deepEqual(await executeHeyGenRead({ kind: 'videos', limit: 10 }, deps), { data: [{ id: 'v1' }] });
  assert.equal(refreshCalls, 1);
  assert.equal(targetCalls, 2);
  assert.deepEqual(events, ['me', 'target', 'refresh', 'persist', 'me', 'target']);
});

test('upstream token and read error bodies are never included in sanitized errors', async () => {
  const leaked = 'CREDENTIAL-JSON-AND-TOKEN-MUST-NOT-LEAK';
  const expired = tokenDoc({ ...BASE_STATE, expiresAt: 1 });
  await assert.rejects(
    () =>
      getHeyGenAccessToken({
        deps: baseDeps({
          read: (async () => ({ doc: expired, etag: 'E1' })) as HeyGenBrokerDeps['read'],
          fetchImpl: (async () => jsonResponse({ error: 'invalid_grant', leaked }, 400)) as typeof fetch,
        }),
      }),
    (error: Error) => /HTTP 400/.test(error.message) && !error.message.includes(leaked),
  );

  const fresh = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
  const paths: string[] = [];
  await assert.rejects(
    () =>
      executeHeyGenRead(
        { kind: 'video', videoId: 'v1' },
        baseDeps({
          read: (async () => ({ doc: fresh, etag: 'E1' })) as HeyGenBrokerDeps['read'],
          fetchImpl: (async (url: string | URL) => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            return path === '/v3/users/me' ? jsonResponse(USER_RESPONSE) : jsonResponse({ leaked }, 500);
          }) as typeof fetch,
        }),
      ),
    (error: Error) => /HTTP 500/.test(error.message) && !error.message.includes(leaked),
  );
  assert.deepEqual(paths, ['/v3/users/me', '/v3/videos/v1']);
});

test('token family fingerprint is stable but contains no refresh-token substring', () => {
  const fp = tokenFamilyFingerprint(BASE_STATE.refreshToken);
  assert.equal(fp, tokenFamilyFingerprint(BASE_STATE.refreshToken));
  assert.equal(fp.length, 32);
  assert.ok(!fp.includes(BASE_STATE.refreshToken));
});
