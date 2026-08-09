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
  executeHeyGenAvatarVideoCreate,
  executeHeyGenPromptAvatarCreate,
  executeHeyGenRead,
  getHeyGenAccessToken,
  getHeyGenVideoOperation,
  getHeyGenPairingStatus,
  newHeyGenPairId,
  parseOfficialCredentialsHeader,
  persistPairedHeyGenToken,
  newHeyGenTokenFamilyFingerprint,
  type HeyGenBrokerDeps,
  type HeyGenTokenDoc,
  type HeyGenTokenState,
} from './broker.js';

const SECRET = 'test-signing-secret-with-enough-entropy-for-hkdf';
const USER_RESPONSE = {
  data: {
    username: 'test-user',
    billing_type: 'subscription',
    subscription: { plan: 'team', credits: { premium_credits: { remaining: 7 } } },
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

test('subscription guard prevents the target for wallet/usage_based/null/empty subscription accounts', async () => {
  for (const guardedUser of [
    { data: { billing_type: 'wallet', wallet: { remaining_balance: 5 } } },
    { data: { billing_type: 'usage_based', usage_based: { remaining_credits: 5 } } },
    { data: { billing_type: 'subscription', subscription: null } },
    { data: { billing_type: 'subscription', subscription: {} } },
  ]) {
    for (const operation of [
      { kind: 'videos' } as const,
      { kind: 'avatarGroups' } as const,
      { kind: 'voiceDesign', prompt: 'existing voice search' } as const,
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
      await assert.rejects(() => executeHeyGenRead(operation, deps), /active subscription/);
      assert.deepEqual(calls, ['/v3/users/me'], 'target must not be called after guard refusal');
    }
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
    {
      operation: { kind: 'avatarGroups', ownership: 'private', limit: 9, token: 'avatar-next' } as const,
      target: '/v3/avatars?ownership=private&limit=9&token=avatar-next',
    },
    {
      operation: { kind: 'avatarGroup', groupId: 'group_id-123' } as const,
      target: '/v3/avatars/group_id-123',
    },
    {
      operation: {
        kind: 'avatarLooks',
        groupId: 'group-1',
        avatarType: 'photo_avatar',
        ownership: 'public',
        limit: 11,
        token: 'look-next',
      } as const,
      target: '/v3/avatars/looks?group_id=group-1&avatar_type=photo_avatar&ownership=public&limit=11&token=look-next',
    },
    {
      operation: { kind: 'avatarLook', lookId: 'look_id-123' } as const,
      target: '/v3/avatars/looks/look_id-123',
    },
    {
      operation: { kind: 'voices' } as const,
      target: '/v3/voices',
    },
    {
      operation: {
        kind: 'voices',
        type: 'private',
        engine: 'starfish',
        language: 'English',
        gender: 'female',
        limit: 13,
        token: 'voice-next',
      } as const,
      target: '/v3/voices?type=private&engine=starfish&language=English&gender=female&limit=13&token=voice-next',
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

test('voice design maps to exact POST /v3/voices JSON and never forwards extra fields', async () => {
  const events: Array<{ path: string; method: string; body?: unknown }> = [];
  const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
  const deps = baseDeps({
    read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      events.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return path === '/v3/users/me' ? jsonResponse(USER_RESPONSE) : jsonResponse({ data: { voices: [], seed: 4 } });
    }) as typeof fetch,
  });
  const result = await executeHeyGenRead(
    { kind: 'voiceDesign', prompt: 'warm narrator', gender: 'female', locale: 'en-US', seed: 4 },
    deps,
  );
  assert.deepEqual(result, { data: { voices: [], seed: 4 } });
  assert.deepEqual(events, [
    { path: '/v3/users/me', method: 'GET', body: undefined },
    {
      path: '/v3/voices',
      method: 'POST',
      body: { prompt: 'warm narrator', gender: 'female', locale: 'en-US', seed: 4 },
    },
  ]);

  events.length = 0;
  await executeHeyGenRead({ kind: 'voiceDesign', prompt: 'second prompt' }, deps);
  assert.deepEqual(events[1]?.body, { prompt: 'second prompt' }, 'optional fields must be omitted, not synthesized');
});

test('video/avatar path inputs reject slash and dot-segment ids before any target request', async () => {
  const cases = [
    { operation: (id: string) => ({ kind: 'video', videoId: id } as const), error: /video_id contains unsupported characters/ },
    { operation: (id: string) => ({ kind: 'avatarGroup', groupId: id } as const), error: /group_id contains unsupported characters/ },
    { operation: (id: string) => ({ kind: 'avatarLook', lookId: id } as const), error: /look_id contains unsupported characters/ },
    { operation: (id: string) => ({ kind: 'avatarLooks', groupId: id } as const), error: /group_id contains unsupported characters/ },
  ];
  for (const id of ['../users/me', '..', '.', 'avatar/id', 'avatar%2Fid']) {
    for (const entry of cases) {
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
      await assert.rejects(() => executeHeyGenRead(entry.operation(id), deps), entry.error);
      assert.deepEqual(calls, ['/v3/users/me'], 'subscription guard may run, but the invalid target must not');
    }

    let createCalls = 0;
    await assert.rejects(
      () => executeHeyGenPromptAvatarCreate(
        {
          name: 'Safe name',
          prompt: 'Safe prompt',
          avatarGroupId: id,
          confirmCreditUse: true,
          confirmedPremiumCreditsBefore: 7,
        },
        baseDeps({
          fetchImpl: (async () => {
            createCalls += 1;
            return jsonResponse(USER_RESPONSE);
          }) as typeof fetch,
        }),
      ),
      /avatar_group_id contains unsupported characters/,
    );
    assert.equal(createCalls, 0, 'invalid create path input must be rejected before any network call');
  }
});

test('new v3 inputs enforce locale, pagination, range, and prompt-avatar length bounds', async () => {
  const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
  for (const operation of [
    { kind: 'avatarGroups', limit: 0 } as const,
    { kind: 'avatarLooks', limit: 51 } as const,
    { kind: 'voices', limit: 101 } as const,
    { kind: 'voices', token: 'x'.repeat(4097) } as const,
    { kind: 'voices', engine: '../starfish' } as const,
    { kind: 'voices', language: ' '.repeat(2) } as const,
    { kind: 'voices', gender: 'unknown' } as const,
    { kind: 'voiceDesign', prompt: 'voice', locale: 'English_US' } as const,
    { kind: 'voiceDesign', prompt: 'voice', seed: -1 } as const,
    { kind: 'voiceDesign', prompt: ' '.repeat(2) } as const,
    { kind: 'voiceDesign', prompt: 'v'.repeat(1001) } as const,
  ]) {
    const paths: string[] = [];
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        paths.push(new URL(String(url)).pathname);
        return jsonResponse(USER_RESPONSE);
      }) as typeof fetch,
    });
    await assert.rejects(() => executeHeyGenRead(operation, deps));
    assert.deepEqual(paths, ['/v3/users/me'], 'invalid broker-direct data input must never reach its target');
  }

  for (const input of [
    { name: '', prompt: 'valid' },
    { name: ' '.repeat(2), prompt: 'valid' },
    { name: 'n'.repeat(101), prompt: 'valid' },
    { name: 'valid', prompt: '' },
    { name: 'valid', prompt: ' '.repeat(2) },
    { name: 'valid', prompt: 'p'.repeat(1001) },
  ]) {
    let calls = 0;
    await assert.rejects(
      () => executeHeyGenPromptAvatarCreate(
        {
          ...input,
          confirmCreditUse: true,
          confirmedPremiumCreditsBefore: 7,
        },
        baseDeps({
          fetchImpl: (async () => {
            calls += 1;
            return jsonResponse(USER_RESPONSE);
          }) as typeof fetch,
        }),
      ),
    );
    assert.equal(calls, 0, 'invalid create length must be rejected before any network call');
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

test('voice design retries only one authentication rejection and never retries 429/5xx', async () => {
  for (const status of [429, 500]) {
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    let targetCalls = 0;
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v3/users/me') return jsonResponse(USER_RESPONSE);
        targetCalls += 1;
        return jsonResponse({ leaked: 'VOICE-DESIGN-BODY' }, status);
      }) as typeof fetch,
    });
    await assert.rejects(
      () => executeHeyGenRead({ kind: 'voiceDesign', prompt: 'warm voice' }, deps),
      (error: Error) => error.message.includes(`HTTP ${status}`) && !error.message.includes('VOICE-DESIGN-BODY'),
    );
    assert.equal(targetCalls, 1, `HTTP ${status} must not be retried`);
  }

  let doc = tokenDoc({ ...BASE_STATE, accessToken: 'voice-access-OLD', expiresAt: 0 });
  let etag = 'E1';
  let targetCalls = 0;
  let refreshCalls = 0;
  const deps = baseDeps({
    read: (async () => ({ doc, etag })) as HeyGenBrokerDeps['read'],
    replace: (async (_c, _pk, _id, next) => {
      doc = next as HeyGenTokenDoc;
      etag = 'E2';
      return { ok: true, status: 200, body: next, etag };
    }) as HeyGenBrokerDeps['replace'],
    fetchImpl: (async (url: string | URL) => {
      if (String(url) === HEYGEN_TOKEN_URL) {
        refreshCalls += 1;
        return jsonResponse({ access_token: 'voice-access-NEW', refresh_token: 'voice-refresh-NEW', expires_in: 3600 });
      }
      const path = new URL(String(url)).pathname;
      if (path === '/v3/users/me') return jsonResponse(USER_RESPONSE);
      targetCalls += 1;
      return jsonResponse({ leaked: 'VOICE-401-BODY' }, 401);
    }) as typeof fetch,
  });
  await assert.rejects(
    () => executeHeyGenRead({ kind: 'voiceDesign', prompt: 'warm voice' }, deps),
    (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes('VOICE-401-BODY'),
  );
  assert.equal(refreshCalls, 1);
  assert.equal(targetCalls, 2, 'one rejected POST plus one retry, never a third POST');
});

test('prompt-avatar create requires explicit confirmation before any account or target request', async () => {
  const baseInput = {
    name: 'Presenter',
    prompt: 'A professional presenter in a bright studio',
    confirmedPremiumCreditsBefore: 7,
  };
  for (const confirmCreditUse of [false, undefined]) {
    let calls = 0;
    await assert.rejects(
      () => executeHeyGenPromptAvatarCreate(
        { ...baseInput, confirmCreditUse } as Parameters<typeof executeHeyGenPromptAvatarCreate>[0],
        baseDeps({
          fetchImpl: (async () => {
            calls += 1;
            return jsonResponse(USER_RESPONSE);
          }) as typeof fetch,
        }),
      ),
      /confirm_credit_use=true/,
    );
    assert.equal(calls, 0);
  }
});

test('prompt-avatar create subscription guard blocks POST for wallet/usage_based/null/empty subscription', async () => {
  const guardedUsers = [
    { data: { billing_type: 'wallet', wallet: { remaining_balance: 5 } } },
    { data: { billing_type: 'usage_based', usage_based: { remaining_credits: 5 } } },
    { data: { billing_type: 'subscription', subscription: null } },
    { data: { billing_type: 'subscription', subscription: {} } },
  ];
  for (const guardedUser of guardedUsers) {
    const paths: string[] = [];
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        paths.push(new URL(String(url)).pathname);
        return jsonResponse(guardedUser);
      }) as typeof fetch,
    });
    await assert.rejects(
      () => executeHeyGenPromptAvatarCreate(
        {
          name: 'Presenter',
          prompt: 'A professional presenter',
          confirmCreditUse: true,
          confirmedPremiumCreditsBefore: 7,
        },
        deps,
      ),
      /active subscription/,
    );
    assert.deepEqual(paths, ['/v3/users/me']);
  }
});

test('prompt-avatar create refuses missing/non-integer/zero or mismatched premium-credit snapshots before POST', async () => {
  const cases = [
    {
      account: { data: { billing_type: 'subscription', subscription: { plan: 'team', credits: {} } } },
      confirmed: 7,
      error: /integer premium-credit balance/,
    },
    {
      account: {
        data: {
          billing_type: 'subscription',
          subscription: { plan: 'team', credits: { premium_credits: { remaining: 1.5 } } },
        },
      },
      confirmed: 1,
      error: /integer premium-credit balance/,
    },
    {
      account: {
        data: {
          billing_type: 'subscription',
          subscription: { plan: 'team', credits: { premium_credits: { remaining: 0 } } },
        },
      },
      confirmed: 0,
      error: /at least 1 remaining premium credit/,
    },
    {
      account: USER_RESPONSE,
      confirmed: 6,
      error: /confirmed 6, current 7/,
    },
  ];
  for (const entry of cases) {
    const paths: string[] = [];
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        paths.push(new URL(String(url)).pathname);
        return jsonResponse(entry.account);
      }) as typeof fetch,
    });
    await assert.rejects(
      () => executeHeyGenPromptAvatarCreate(
        {
          name: 'Presenter',
          prompt: 'A professional presenter',
          confirmCreditUse: true,
          confirmedPremiumCreditsBefore: entry.confirmed,
        },
        deps,
      ),
      entry.error,
    );
    assert.deepEqual(paths, ['/v3/users/me'], 'credit refusal must happen before POST /v3/avatars');
  }

  for (const confirmed of [undefined, 1.5, -1]) {
    let calls = 0;
    await assert.rejects(
      () => executeHeyGenPromptAvatarCreate(
        {
          name: 'Presenter',
          prompt: 'A professional presenter',
          confirmCreditUse: true,
          confirmedPremiumCreditsBefore: confirmed,
        } as Parameters<typeof executeHeyGenPromptAvatarCreate>[0],
        baseDeps({
          fetchImpl: (async () => {
            calls += 1;
            return jsonResponse(USER_RESPONSE);
          }) as typeof fetch,
        }),
      ),
      /confirmed_premium_credits_before must be a non-negative integer/,
    );
    assert.equal(calls, 0);
  }
});

test('prompt-avatar create accepts only an exact positive snapshot and emits one exact POST body', async () => {
  const events: Array<{ path: string; method: string; body?: unknown; authorization?: string }> = [];
  const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
  const deps = baseDeps({
    read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const headers = init?.headers as Record<string, string> | undefined;
      events.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers?.Authorization,
      });
      return path === '/v3/users/me'
        ? jsonResponse(USER_RESPONSE)
        : jsonResponse({ data: { avatar_item: { id: 'look-1', group_id: 'group-1' } } });
    }) as typeof fetch,
  });
  const result = await executeHeyGenPromptAvatarCreate(
    {
      name: ' Presenter ',
      prompt: ' A professional presenter in a bright studio ',
      avatarGroupId: 'existing_group-1',
      confirmCreditUse: true,
      confirmedPremiumCreditsBefore: 7,
    },
    deps,
  );
  assert.deepEqual(result, {
    body: { data: { avatar_item: { id: 'look-1', group_id: 'group-1' } } },
    plan: 'team',
    premiumCreditsBefore: 7,
  });
  assert.deepEqual(events.map(({ path, method }) => ({ path, method })), [
    { path: '/v3/users/me', method: 'GET' },
    { path: '/v3/avatars', method: 'POST' },
  ]);
  assert.deepEqual(events[1]?.body, {
    type: 'prompt',
    name: 'Presenter',
    prompt: 'A professional presenter in a bright studio',
    avatar_group_id: 'existing_group-1',
  });
  assert.equal((events[1]?.body as Record<string, unknown>).confirm_credit_use, undefined);
  assert.equal((events[1]?.body as Record<string, unknown>).confirmed_premium_credits_before, undefined);
  assert.equal((events[1]?.body as Record<string, unknown>).reference_images, undefined);
  assert.equal(events[1]?.authorization, `Bearer ${BASE_STATE.accessToken}`);
});

test('prompt-avatar create never retries network/429/5xx or ambiguous success-response failures', async () => {
  for (const mode of ['network', '429', '500', 'invalid-success'] as const) {
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    let targetCalls = 0;
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v3/users/me') return jsonResponse(USER_RESPONSE);
        targetCalls += 1;
        if (mode === 'network') throw new Error('NETWORK-TOKEN-SHOULD-NOT-LEAK');
        if (mode === 'invalid-success') return new Response('not-json', { status: 200 });
        return jsonResponse({ leaked: 'CREATE-UPSTREAM-BODY' }, Number(mode));
      }) as typeof fetch,
    });
    await assert.rejects(
      () => executeHeyGenPromptAvatarCreate(
        {
          name: 'Presenter',
          prompt: 'A professional presenter',
          confirmCreditUse: true,
          confirmedPremiumCreditsBefore: 7,
        },
        deps,
      ),
      (error: Error) => {
        const sanitized =
          !error.message.includes('CREATE-UPSTREAM-BODY') &&
          !error.message.includes('NETWORK-TOKEN-SHOULD-NOT-LEAK') &&
          !error.message.includes(BASE_STATE.accessToken);
        if (!sanitized) return false;
        return mode === 'network' || mode === 'invalid-success'
          ? /may have been accepted/.test(error.message)
          : /request was not retried; check HeyGen/.test(error.message);
      },
    );
    assert.equal(targetCalls, 1, `${mode} must never retry POST /v3/avatars`);
  }
});

test('prompt-avatar create permits at most one forced refresh and one full retry after target 401', async () => {
  let doc = tokenDoc({ ...BASE_STATE, accessToken: 'create-access-OLD', expiresAt: 0 });
  let etag = 'E1';
  let refreshCalls = 0;
  let targetCalls = 0;
  const events: string[] = [];
  const postBodies: unknown[] = [];
  const deps = baseDeps({
    read: (async () => ({ doc, etag })) as HeyGenBrokerDeps['read'],
    replace: (async (_c, _pk, _id, next) => {
      events.push('persist');
      doc = next as HeyGenTokenDoc;
      etag = 'E2';
      return { ok: true, status: 200, body: next, etag };
    }) as HeyGenBrokerDeps['replace'],
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      if (String(url) === HEYGEN_TOKEN_URL) {
        refreshCalls += 1;
        events.push('refresh');
        return jsonResponse({ access_token: 'create-access-NEW', refresh_token: 'create-refresh-NEW', expires_in: 3600 });
      }
      const path = new URL(String(url)).pathname;
      if (path === '/v3/users/me') {
        events.push('me');
        return jsonResponse(USER_RESPONSE);
      }
      targetCalls += 1;
      events.push('target');
      postBodies.push(JSON.parse(String(init?.body)));
      return targetCalls === 1
        ? jsonResponse({ leaked: 'CREATE-401-BODY' }, 401)
        : jsonResponse({ data: { avatar_item: { id: 'created-look' } } });
    }) as typeof fetch,
  });
  const result = await executeHeyGenPromptAvatarCreate(
    {
      name: 'Presenter',
      prompt: 'A professional presenter',
      confirmCreditUse: true,
      confirmedPremiumCreditsBefore: 7,
    },
    deps,
  );
  assert.deepEqual(result.body, { data: { avatar_item: { id: 'created-look' } } });
  assert.equal(refreshCalls, 1);
  assert.equal(targetCalls, 2);
  assert.deepEqual(events, ['me', 'target', 'refresh', 'persist', 'me', 'target']);
  assert.deepEqual(postBodies, [
    { type: 'prompt', name: 'Presenter', prompt: 'A professional presenter' },
    { type: 'prompt', name: 'Presenter', prompt: 'A professional presenter' },
  ]);

  let deniedDoc = tokenDoc({ ...BASE_STATE, accessToken: 'denied-access-OLD', expiresAt: 0 });
  let deniedEtag = 'D1';
  let deniedRefreshes = 0;
  let deniedTargets = 0;
  const deniedDeps = baseDeps({
    read: (async () => ({ doc: deniedDoc, etag: deniedEtag })) as HeyGenBrokerDeps['read'],
    replace: (async (_c, _pk, _id, next) => {
      deniedDoc = next as HeyGenTokenDoc;
      deniedEtag = 'D2';
      return { ok: true, status: 200, body: next, etag: deniedEtag };
    }) as HeyGenBrokerDeps['replace'],
    fetchImpl: (async (url: string | URL) => {
      if (String(url) === HEYGEN_TOKEN_URL) {
        deniedRefreshes += 1;
        return jsonResponse({ access_token: 'denied-access-NEW', refresh_token: 'denied-refresh-NEW', expires_in: 3600 });
      }
      const path = new URL(String(url)).pathname;
      if (path === '/v3/users/me') return jsonResponse(USER_RESPONSE);
      deniedTargets += 1;
      return jsonResponse({ leaked: 'SECOND-CREATE-401-BODY' }, 401);
    }) as typeof fetch,
  });
  await assert.rejects(
    () => executeHeyGenPromptAvatarCreate(
      {
        name: 'Presenter',
        prompt: 'A professional presenter',
        confirmCreditUse: true,
        confirmedPremiumCreditsBefore: 7,
      },
      deniedDeps,
    ),
    (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes('SECOND-CREATE-401-BODY'),
  );
  assert.equal(deniedRefreshes, 1);
  assert.equal(deniedTargets, 2, 'two 401 responses must stop after one refresh and one retry');
});

test('upstream token and operation error bodies are never included in sanitized errors', async () => {
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

test('token family fingerprint is random metadata, not derived from OAuth material', () => {
  const fp = newHeyGenTokenFamilyFingerprint(fixedRandom(4));
  assert.equal(fp, '04'.repeat(16));
  assert.equal(fp.length, 32);
  assert.ok(!fp.includes(BASE_STATE.refreshToken));
  assert.notEqual(fp, newHeyGenTokenFamilyFingerprint(fixedRandom(5)));
});

function avatarVideoInput(overrides: Record<string, unknown> = {}): Parameters<typeof executeHeyGenAvatarVideoCreate>[0] {
  return {
    operationId: 'video_op_01',
    idempotencyKey: 'video-op:01',
    manifestSha256: 'a'.repeat(64),
    title: 'Executive update',
    avatarId: 'look_1',
    voiceId: 'voice_1',
    script: 'Exact approved script.',
    engine: 'avatar_v',
    resolution: '720p',
    aspectRatio: 'auto',
    confirmCreditUse: true,
    confirmedPremiumCreditsBefore: 7,
    maxApprovedCredits: 2,
    reservePremiumCredits: 5,
    ...overrides,
  } as Parameters<typeof executeHeyGenAvatarVideoCreate>[0];
}

function avatarVideoHarness(options: {
  post?: (call: number) => Response | Promise<Response>;
  account?: unknown;
  look?: unknown;
  group?: unknown;
  voice?: unknown;
} = {}) {
  type Stored = { doc: Record<string, unknown>; etag: string };
  const store = new Map<string, Stored>();
  store.set(HEYGEN_TOKEN_DOC_ID, { doc: tokenDoc({ ...BASE_STATE, expiresAt: 0 }), etag: 'T1' });
  let etag = 1;
  let postCalls = 0;
  const requests: Array<{ path: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const deps = baseDeps({
    now: () => 1_000_000,
    sleep: async () => undefined,
    read: (async (_coll, pk, id) => {
      assert.equal(pk, id);
      const row = store.get(id);
      return row ? { doc: row.doc, etag: row.etag } : null;
    }) as HeyGenBrokerDeps['read'],
    create: (async (_coll, pk, doc) => {
      const id = String(doc.id);
      assert.equal(pk, id);
      if (store.has(id)) throw new Error('conflict');
      const nextEtag = `E${++etag}`;
      store.set(id, { doc, etag: nextEtag });
      return { ok: true, status: 201, body: doc, etag: nextEtag };
    }) as HeyGenBrokerDeps['create'],
    replace: (async (_coll, pk, id, doc, ifMatch) => {
      assert.equal(pk, id);
      const current = store.get(id);
      if (!current || current.etag !== ifMatch) return { ok: false, status: 412, body: null, etag: null };
      const nextEtag = `E${++etag}`;
      store.set(id, { doc, etag: nextEtag });
      return { ok: true, status: 200, body: doc, etag: nextEtag };
    }) as HeyGenBrokerDeps['replace'],
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        path: parsed.pathname + parsed.search,
        method: init?.method ?? 'GET',
        headers: headers ?? {},
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (parsed.pathname === '/v3/users/me') return jsonResponse(options.account ?? USER_RESPONSE);
      if (parsed.pathname === '/v3/avatars/looks/look_1') return jsonResponse(options.look ?? {
        data: {
          id: 'look_1', avatar_type: 'digital_twin', group_id: 'group_1', default_voice_id: 'voice_1',
          supported_api_engines: ['avatar_iii', 'avatar_iv', 'avatar_v'], status: 'completed',
        },
      });
      if (parsed.pathname === '/v3/avatars/group_1') return jsonResponse(options.group ?? {
        data: { id: 'group_1', status: 'completed', consent_status: 'approved' },
      });
      if (parsed.pathname === '/v3/voices/voice_1') return jsonResponse(options.voice ?? {
        data: { voice_id: 'voice_1', status: 'complete', support_pause: true },
      });
      if (parsed.pathname === '/v3/videos') {
        postCalls += 1;
        return options.post ? options.post(postCalls) : jsonResponse({ data: { video_id: 'v_1', status: 'pending' } });
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    }) as typeof fetch,
  });
  return { deps, store, requests, postCalls: () => postCalls };
}

test('direct Avatar Video create runs guarded live preflight, sends one exact idempotent POST, and persists accepted state', async () => {
  const harness = avatarVideoHarness();
  const result = await executeHeyGenAvatarVideoCreate(avatarVideoInput(), harness.deps);
  assert.equal(result.state, 'accepted');
  assert.equal(result.videoId, 'v_1');
  assert.equal(result.replayed, false);
  assert.deepEqual(harness.requests.map((entry) => [entry.method, entry.path]), [
    ['GET', '/v3/users/me'],
    ['GET', '/v3/avatars/looks/look_1'],
    ['GET', '/v3/avatars/group_1'],
    ['GET', '/v3/voices/voice_1'],
    ['POST', '/v3/videos'],
  ]);
  const post = harness.requests.at(-1)!;
  assert.equal(post.headers['Idempotency-Key'], 'video-op:01');
  assert.deepEqual(post.body, {
    type: 'avatar',
    title: 'Executive update',
    avatar_id: 'look_1',
    voice_id: 'voice_1',
    script: 'Exact approved script.',
    engine: { type: 'avatar_v' },
    resolution: '720p',
    aspect_ratio: 'auto',
    output_format: 'mp4',
    callback_id: 'video_op_01',
  });
  assert.equal(JSON.stringify(post.body).includes('confirm_credit_use'), false);
  assert.equal(JSON.stringify(post.body).includes('max_approved_credits'), false);
  assert.equal(JSON.stringify([...harness.store.values()]).includes('video-op:01'), false, 'raw key must not be persisted');
  assert.equal(JSON.stringify([...harness.store.values()]).includes('Exact approved script'), false, 'raw script must not be persisted');
  const stored = await getHeyGenVideoOperation('video_op_01', harness.deps);
  assert.equal(stored?.state, 'accepted');
  assert.equal(stored?.videoId, 'v_1');
});

test('accepted operation replays without network and changed payload is refused locally', async () => {
  const harness = avatarVideoHarness();
  const input = avatarVideoInput();
  await executeHeyGenAvatarVideoCreate(input, harness.deps);
  const calls = harness.requests.length;
  const replay = await executeHeyGenAvatarVideoCreate(input, harness.deps);
  assert.equal(replay.state, 'accepted');
  assert.equal(replay.replayed, true);
  assert.equal(harness.requests.length, calls, 'accepted replay must not call HeyGen');
  await assert.rejects(
    () => executeHeyGenAvatarVideoCreate(avatarVideoInput({ script: 'Changed script.' }), harness.deps),
    /already bound to a different request/,
  );
  assert.equal(harness.requests.length, calls, 'conflicting replay must not call HeyGen');
});

test('credit snapshot and reserve violations block before POST', async () => {
  for (const input of [
    avatarVideoInput({ confirmedPremiumCreditsBefore: 6 }),
    avatarVideoInput({ maxApprovedCredits: 3, reservePremiumCredits: 5 }),
  ]) {
    const harness = avatarVideoHarness();
    await assert.rejects(() => executeHeyGenAvatarVideoCreate(input, harness.deps), /balance changed|reserve floor/);
    assert.equal(harness.postCalls(), 0);
    assert.deepEqual(harness.requests.map((entry) => entry.path), [
      '/v3/users/me', '/v3/avatars/looks/look_1', '/v3/avatars/group_1', '/v3/voices/voice_1',
    ]);
  }
});

test('look, group, voice, and Avatar V reference incompatibilities block before POST', async () => {
  const cases = [
    {
      options: { look: { data: { id: 'look_1', avatar_type: 'digital_twin', group_id: 'group_1', supported_api_engines: ['avatar_iv'], status: 'completed' } } },
      input: avatarVideoInput(),
      error: /does not support avatar_v/,
    },
    {
      options: { group: { data: { id: 'group_1', status: 'pending_consent', consent_status: 'pending' } } },
      input: avatarVideoInput(),
      error: /not completed/,
    },
    {
      options: { voice: { data: { voice_id: 'voice_1', status: 'failed', support_pause: true } } },
      input: avatarVideoInput(),
      error: /voice is not ready/,
    },
    {
      options: { look: { data: { id: 'look_1', avatar_type: 'photo_avatar', group_id: 'group_1', supported_api_engines: ['avatar_v'], status: 'completed' } } },
      input: avatarVideoInput(),
      error: /explicit completed Digital Twin reference/,
    },
  ];
  for (const entry of cases) {
    const harness = avatarVideoHarness(entry.options);
    await assert.rejects(() => executeHeyGenAvatarVideoCreate(entry.input, harness.deps), entry.error);
    assert.equal(harness.postCalls(), 0);
  }
});

test('429 and 5xx retry exactly once with the same provider key; repeated ambiguity becomes outcome_unknown', async () => {
  const harness = avatarVideoHarness({
    post: (call) => call === 1
      ? new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' },
        })
      : jsonResponse({ data: { video_id: 'v_retry', status: 'pending' } }),
  });
  const result = await executeHeyGenAvatarVideoCreate(avatarVideoInput(), harness.deps);
  assert.equal(result.state, 'accepted');
  assert.equal(result.videoId, 'v_retry');
  const posts = harness.requests.filter((entry) => entry.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((entry) => entry.headers['Idempotency-Key']), ['video-op:01', 'video-op:01']);
  assert.deepEqual(posts[0].body, posts[1].body);

  const unknownHarness = avatarVideoHarness({ post: () => new Response('unavailable', { status: 503 }) });
  const unknown = await executeHeyGenAvatarVideoCreate(avatarVideoInput(), unknownHarness.deps);
  assert.equal(unknown.state, 'outcome_unknown');
  assert.equal(unknownHarness.postCalls(), 2);
});

test('provider 409 request_in_progress returns durable in_progress without minting a new operation', async () => {
  const harness = avatarVideoHarness({
    post: () => jsonResponse({ error: { code: 'request_in_progress', message: 'retry' } }, 409),
  });
  const result = await executeHeyGenAvatarVideoCreate(avatarVideoInput(), harness.deps);
  assert.equal(result.state, 'in_progress');
  assert.equal(result.errorCode, 'request_in_progress');
  assert.equal(harness.postCalls(), 1);
});

test('Phase 0 read operations map to exact v3 paths and query names', async () => {
  const operations = [
    [{ kind: 'videoStatuses', videoIds: ['v1'], batchIds: ['b1'] } as const, '/v3/videos/statuses?video_ids=v1&batch_ids=b1'],
    [{ kind: 'videoAgentSessions', limit: 20, token: 'next' } as const, '/v3/video-agents?limit=20&token=next'],
    [{ kind: 'videoAgentSession', sessionId: 's1' } as const, '/v3/video-agents/s1'],
    [{ kind: 'videoAgentSessionVideos', sessionId: 's1' } as const, '/v3/video-agents/s1/videos'],
    [{ kind: 'brandKits', limit: 10 } as const, '/v3/brand-kits?limit=10'],
    [{ kind: 'brandGlossaries', limit: 10 } as const, '/v3/brand-glossaries?limit=10'],
    [{ kind: 'brandGlossary', brandGlossaryId: 'g1' } as const, '/v3/brand-glossaries/g1'],
    [{ kind: 'voice', voiceId: 'voice1' } as const, '/v3/voices/voice1'],
    [{ kind: 'translationLanguages' } as const, '/v3/video-translations/languages'],
    [{ kind: 'translations', limit: 10 } as const, '/v3/video-translations?limit=10'],
    [{ kind: 'translation', translationId: 't1' } as const, '/v3/video-translations/t1'],
    [{ kind: 'translationStatuses', translationIds: ['t1'], batchIds: ['b1'] } as const, '/v3/video-translations/statuses?video_translation_ids=t1&batch_ids=b1'],
    [{ kind: 'proofread', proofreadId: 'p1' } as const, '/v3/video-translations/proofreads/p1'],
  ] as const;
  for (const [operation, expected] of operations) {
    const paths: string[] = [];
    const doc = tokenDoc({ ...BASE_STATE, expiresAt: 0 });
    const deps = baseDeps({
      read: (async () => ({ doc, etag: 'E1' })) as HeyGenBrokerDeps['read'],
      fetchImpl: (async (url: string | URL) => {
        const parsed = new URL(String(url));
        paths.push(parsed.pathname + parsed.search);
        return parsed.pathname === '/v3/users/me' ? jsonResponse(USER_RESPONSE) : jsonResponse({ data: [] });
      }) as typeof fetch,
    });
    await executeHeyGenRead(operation, deps);
    assert.deepEqual(paths, ['/v3/users/me', expected]);
  }
});
