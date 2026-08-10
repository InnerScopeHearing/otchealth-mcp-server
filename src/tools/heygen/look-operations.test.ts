import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import {
  buildHeyGenTokenDoc,
  HEYGEN_TOKEN_DOC_ID,
  type HeyGenBrokerDeps,
  type HeyGenTokenState,
} from './broker.js';
import {
  executeHeyGenReferenceLookCreate,
  getHeyGenReferenceLookOperation,
} from './look-operations.js';
import {
  buildHeyGenReferenceLookPlan,
  parseHeyGenBillingSnapshot,
  type HeyGenReferenceLookCreateInput,
} from './look-contracts.js';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.HEYGEN_OWNER_APPROVAL_ISSUER = 'https://approval.test';
process.env.HEYGEN_OWNER_APPROVAL_AUDIENCE = 'otchealth-heygen';
process.env.HEYGEN_OWNER_APPROVAL_SUBJECT = 'matt-owner-id';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
publicJwk.kid = 'key-1';
process.env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK = JSON.stringify(publicJwk);

const SECRET = 'test-signing-secret-with-enough-entropy-for-hkdf';
const NOW_MS = 1_800_000_000_000;
const ACCOUNT_BEFORE = {
  data: {
    billing_type: 'subscription',
    username: 'account_1',
    subscription: {
      plan: 'creator',
      credits: {
        premium_credits: { remaining: 981, resets_at: '2026-09-08T19:24:42Z' },
        add_on_credits: {},
      },
    },
  },
};
const ACCOUNT_AFTER = {
  data: {
    billing_type: 'subscription',
    username: 'account_1',
    subscription: {
      plan: 'creator',
      credits: {
        premium_credits: { remaining: 980, resets_at: '2026-09-08T19:24:42Z' },
        add_on_credits: {},
      },
    },
  },
};
const TOKEN_STATE: HeyGenTokenState = {
  accessToken: 'access-token-SENSITIVE',
  refreshToken: 'refresh-token-SENSITIVE',
  expiresAt: NOW_MS + 3_600_000,
  scope: 'openid profile email',
  tokenType: 'Bearer',
};

function enc(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function ownerGrant(input: HeyGenReferenceLookCreateInput, billingSnapshotSha256: string): string {
  const plan = buildHeyGenReferenceLookPlan(input);
  const header = enc({ alg: 'ES256', typ: 'OTC-HeyGen-Approval+jwt', kid: 'key-1' });
  const now = Math.floor(NOW_MS / 1000);
  const payload = enc({
    iss: 'https://approval.test',
    aud: 'otchealth-heygen',
    sub: 'matt-owner-id',
    iat: now,
    nbf: now,
    exp: now + 300,
    jti: `grant-${input.operationId}`,
    grant_type: 'heygen_reference_look_create',
    tool: 'heygen_reference_look_create',
    operation_id: input.operationId,
    request_sha256: plan.requestSha256,
    billing_snapshot_sha256: billingSnapshotSha256,
    billing_state_sha256: input.confirmedBillingStateSha256,
    billing_observed_at: input.confirmedBillingObservedAt,
    confirmed_premium_credits_before: input.confirmedPremiumCreditsBefore,
    reserve_credits: input.reservePremiumCredits,
    max_credits: 1,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function input(overrides: Partial<HeyGenReferenceLookCreateInput> = {}): HeyGenReferenceLookCreateInput {
  const snapshot = parseHeyGenBillingSnapshot(ACCOUNT_BEFORE, new Date(NOW_MS).toISOString());
  const base: HeyGenReferenceLookCreateInput = {
    operationId: 'look_op_01',
    idempotencyKey: 'look-op:01',
    sourceAvatarId: 'look_source',
    destinationGroupId: 'group_1',
    name: 'OTCH Family Story - Kimberly',
    prompt: 'Photorealistic horizontal documentary portrait.',
    referenceAssetIds: ['asset_1'],
    confirmedBillingSnapshotSha256: snapshot.snapshot_sha256,
    confirmedBillingStateSha256: snapshot.state_sha256,
    confirmedBillingObservedAt: snapshot.observed_at,
    confirmedPremiumCreditsBefore: snapshot.premium.remaining ?? undefined,
    reservePremiumCredits: 100,
    confirmCreditUse: true,
  };
  const merged = { ...base, ...overrides };
  merged.ownerApprovalJws = ownerGrant(merged, merged.confirmedBillingSnapshotSha256!);
  return merged;
}

function harness(options: { postStatus?: number; after?: unknown; group?: unknown; asset?: unknown } = {}) {
  type Row = { doc: Record<string, unknown>; etag: string };
  const store = new Map<string, Row>();
  const tokenDoc = buildHeyGenTokenDoc({
    state: TOKEN_STATE,
    signingSecret: SECRET,
    userResponse: ACCOUNT_BEFORE,
    nowMs: NOW_MS,
    randomBytesImpl: (size) => Buffer.alloc(size, 3),
  });
  store.set(HEYGEN_TOKEN_DOC_ID, { doc: tokenDoc, etag: 'T1' });
  let serial = 1;
  let accountReads = 0;
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
  const deps: HeyGenBrokerDeps = {
    now: () => NOW_MS,
    randomBytes: (size) => Buffer.alloc(size, 7),
    signingSecret: () => SECRET,
    read: (async (_container, pk, id) => {
      assert.equal(pk, id);
      const row = store.get(id);
      return row ? { doc: row.doc, etag: row.etag } : null;
    }) as HeyGenBrokerDeps['read'],
    create: (async (_container, pk, doc) => {
      const id = String(doc.id);
      assert.equal(pk, id);
      if (store.has(id)) throw new Error('conflict');
      const etag = `E${++serial}`;
      store.set(id, { doc, etag });
      return { ok: true, status: 201, body: doc, etag };
    }) as HeyGenBrokerDeps['create'],
    replace: (async (_container, pk, id, doc, ifMatch) => {
      assert.equal(pk, id);
      const current = store.get(id);
      if (!current || current.etag !== ifMatch) return { ok: false, status: 412, body: null, etag: null };
      const etag = `E${++serial}`;
      store.set(id, { doc, etag });
      return { ok: true, status: 200, body: doc, etag };
    }) as HeyGenBrokerDeps['replace'],
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ method, path: parsed.pathname, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (parsed.pathname === '/v3/users/me') {
        accountReads += 1;
        return json(accountReads === 1 ? ACCOUNT_BEFORE : (options.after ?? ACCOUNT_AFTER));
      }
      if (parsed.pathname === '/v3/avatars/looks/look_source') return json({
        data: { id: 'look_source', avatar_type: 'photo_avatar', group_id: 'group_1', supported_api_engines: ['avatar_iv'], status: 'completed' },
      });
      if (parsed.pathname === '/v3/avatars/group_1') return json(options.group ?? {
        data: { id: 'group_1', status: 'completed', consent_status: 'accepted' },
      });
      if (parsed.pathname === '/v3/assets/asset_1') return json(options.asset ?? {
        data: { id: 'asset_1', name: 'wardrobe.png', type: 'image', owner: 'owner', space_id: 'space_1', uploaded_at: 1, url: 'https://files.heygen.ai/a.png?sig=SECRET' },
      });
      if (parsed.pathname === '/v3/avatars' && method === 'POST') return json({
        data: { avatar_item: { id: 'look_created', group_id: 'group_1', status: 'processing' }, avatar_group: null },
      }, options.postStatus ?? 200);
      if (parsed.pathname === '/v3/avatars/looks/look_created') return json({
        data: { id: 'look_created', avatar_type: 'photo_avatar', group_id: 'group_1', supported_api_engines: ['avatar_iv'], status: 'completed' },
      });
      throw new Error(`unexpected ${method} ${parsed.pathname}`);
    }) as typeof fetch,
  };
  return { deps, store, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('reference-Look execution is single-flight, owner-bound, idempotent, post-verified, and reconciles one credit', async () => {
  const h = harness();
  const first = await executeHeyGenReferenceLookCreate(input(), h.deps);
  assert.equal(first.state, 'accepted');
  assert.equal(first.provider_look_id, 'look_created');
  assert.equal(first.actual_credit_delta, 1);
  assert.equal(first.verification_status, 'verified');
  const posts = h.requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['Idempotency-Key'], 'look-op:01');
  assert.deepEqual(posts[0].body, {
    type: 'prompt',
    name: 'OTCH Family Story - Kimberly',
    prompt: 'Photorealistic horizontal documentary portrait.',
    avatar_id: 'look_source',
    avatar_group_id: 'group_1',
    reference_images: [{ type: 'asset_id', asset_id: 'asset_1' }],
  });
  const requestCount = h.requests.length;
  const replay = await executeHeyGenReferenceLookCreate(input(), h.deps);
  assert.equal(replay.state, 'accepted');
  assert.equal(replay.replayed, true);
  assert.equal(h.requests.length, requestCount);
  const stored = await getHeyGenReferenceLookOperation('look_op_01', h.deps);
  assert.equal(stored?.state, 'accepted');
  const persisted = JSON.stringify([...h.store.values()]);
  assert.equal(persisted.includes('Photorealistic horizontal'), false);
  assert.equal(persisted.includes('look-op:01'), false);
  assert.equal(persisted.includes('eyJ'), false);
  assert.equal(persisted.includes('sig=SECRET'), false);
});

test('request drift under one operation fails before a second provider POST', async () => {
  const h = harness();
  await executeHeyGenReferenceLookCreate(input(), h.deps);
  await assert.rejects(
    () => executeHeyGenReferenceLookCreate(input({ prompt: 'Changed prompt.' }), h.deps),
    /already bound to a different/,
  );
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 1);
});

test('billing drift and provider ambiguity fail closed without automatic retry', async () => {
  const drift = harness({ after: ACCOUNT_BEFORE });
  const driftResult = await executeHeyGenReferenceLookCreate(input(), drift.deps);
  assert.equal(driftResult.state, 'accepted');
  assert.equal(driftResult.actual_credit_delta, 0);
  assert.equal(driftResult.error_code, 'unexpected_credit_delta');
  assert.equal(drift.requests.filter((request) => request.method === 'POST').length, 1);

  const ambiguous = harness({ postStatus: 503 });
  const unknown = await executeHeyGenReferenceLookCreate(input(), ambiguous.deps);
  assert.equal(unknown.state, 'outcome_unknown');
  assert.equal(ambiguous.requests.filter((request) => request.method === 'POST').length, 1);
});

test('pending consent and non-image reference assets block before provider POST', async () => {
  const pending = harness({
    group: { data: { id: 'group_1', status: 'pending_consent', consent_status: 'pending' } },
  });
  const pendingResult = await executeHeyGenReferenceLookCreate(input(), pending.deps);
  assert.equal(pendingResult.state, 'rejected');
  assert.equal(pending.requests.filter((request) => request.method === 'POST').length, 0);

  const audio = harness({
    asset: { data: { id: 'asset_1', name: 'voice.mp3', type: 'audio', owner: 'owner', space_id: 'space_1', uploaded_at: 1, url: null } },
  });
  const audioResult = await executeHeyGenReferenceLookCreate(input(), audio.deps);
  assert.equal(audioResult.state, 'rejected');
  assert.equal(audio.requests.filter((request) => request.method === 'POST').length, 0);
});

test('tampered owner grant blocks before provider POST and is durably rejected', async () => {
  const h = harness();
  const bad = input();
  const parts = bad.ownerApprovalJws!.split('.');
  parts[2] = `${parts[2]![0] === 'A' ? 'B' : 'A'}${parts[2]!.slice(1)}`;
  bad.ownerApprovalJws = parts.join('.');
  const result = await executeHeyGenReferenceLookCreate(bad, h.deps);
  assert.equal(result.state, 'rejected');
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 0);
});
