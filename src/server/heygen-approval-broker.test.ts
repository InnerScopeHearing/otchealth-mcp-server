import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import Fastify from 'fastify';
import { createHeyGenApprovalContextToken } from '../tools/heygen/approval-context.js';
import { decryptHeyGenOwnerApprovalHandle } from '../tools/heygen/approval-handle.js';
import { verifyHeyGenAvatarVideoApproval } from '../tools/heygen/owner-approval.js';
import { registerHeyGenApprovalBrokerRoutes, type HeyGenApprovalBrokerDeps } from './heygen-approval-broker.js';

const NOW = 1_800_000_000_000;
const CONTEXT = 'context-secret-with-at-least-thirty-two-bytes';
const HANDLE = 'handle-secret-with-at-least-thirty-two-bytes';
const CALLBACK = 'callback-secret-with-at-least-thirty-two-bytes';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateJwk = privateKey.export({ format: 'jwk' }) as JsonWebKey;
const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
privateJwk.kid = 'heygen-owner-2026-01';
publicJwk.kid = privateJwk.kid;

const packet = {
  grant_type: 'heygen_avatar_video_create',
  tool: 'heygen_avatar_video_create',
  operation_id: 'family_v_matt_canary_01',
  request_sha256: 'a'.repeat(64),
  idempotency_key_sha256: 'b'.repeat(64),
  manifest_sha256: 'c'.repeat(64),
  billing_snapshot_sha256: 'd'.repeat(64),
  billing_state_sha256: 'e'.repeat(64),
  billing_observed_at: new Date(NOW).toISOString(),
  confirmed_premium_credits_before: 588,
  reserve_credits: 500,
  max_credits: 3,
  conservative_credit_cap: 3,
  provider_credit_cap_available: false,
  gateway_pre_submission_cap_enforced: true,
  post_call_overage_locks_account: true,
  family_story_exact_cap_required: true,
  owner_grant_required: true,
  zero_automatic_retries: true,
} as const;

function env(): void {
  process.env.DESCOPE_PROJECT_ID = 'P3G94xD2P1fl2GxusxmIsGIg6gRM';
  process.env.HEYGEN_OWNER_APPROVAL_ISSUER = 'https://approval.otchealth.app';
  process.env.HEYGEN_OWNER_APPROVAL_AUDIENCE = 'otchealth-heygen';
  process.env.HEYGEN_OWNER_APPROVAL_SUBJECT = 'matthew@otchealthmart.com';
  process.env.HEYGEN_OWNER_APPROVAL_PRIVATE_JWK = JSON.stringify(privateJwk);
  process.env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK = JSON.stringify(publicJwk);
  process.env.HEYGEN_OWNER_APPROVAL_EMAIL = 'matthew@otchealthmart.com';
  process.env.HEYGEN_APPROVAL_CONTEXT_SECRET = CONTEXT;
  process.env.HEYGEN_APPROVAL_HANDLE_SECRET = HANDLE;
  process.env.HEYGEN_APPROVAL_CALLBACK_SECRET = CALLBACK;
  process.env.HEYGEN_APPROVAL_CALLBACK_URL = 'https://mcp.otchealth.app/heygen/approval/callback';
}

function fixedRandom(size: number): Buffer {
  return Buffer.alloc(size, 9);
}

test('owner OTP flow signs one exact grant, returns no JWS/handle, and callbacks only an encrypted handle', async () => {
  env();
  let callbackPayload: Record<string, unknown> | null = null;
  const deps: HeyGenApprovalBrokerDeps = {
    now: () => NOW,
    random: fixedRandom,
    startOtp: async (email) => {
      assert.equal(email, 'matthew@otchealthmart.com');
      return { maskedEmail: 'm***@otchealthmart.com' };
    },
    verifyOtp: async (email, code) => {
      assert.equal(email, 'matthew@otchealthmart.com');
      assert.equal(code, '123456');
      return { email, loginIds: [email], verifiedEmail: true };
    },
    callback: async (payload, secret, url) => {
      assert.equal(secret, CALLBACK);
      assert.equal(url, process.env.HEYGEN_APPROVAL_CALLBACK_URL);
      callbackPayload = payload;
    },
  };
  const app = Fastify({ logger: false });
  registerHeyGenApprovalBrokerRoutes(app, deps);
  const context = createHeyGenApprovalContextToken(packet, CONTEXT, NOW, 600);
  const start = await app.inject({ method: 'POST', url: '/v1/heygen/avatar-video/start', payload: { context_token: context.token } });
  assert.equal(start.statusCode, 200);
  const started = start.json();
  assert.equal(started.operation_id, packet.operation_id);
  assert.equal(started.max_credits, 3);
  assert.ok(!JSON.stringify(started).includes('owner_approval_jws'));

  const complete = await app.inject({
    method: 'POST', url: '/v1/heygen/avatar-video/complete',
    payload: { challenge_token: started.challenge_token, code: '123456' },
  });
  assert.equal(complete.statusCode, 200);
  const completed = complete.json();
  assert.deepEqual(Object.keys(completed).sort(), ['approved', 'operation_id', 'owner_approval_expires_at', 'packet_sha256']);
  assert.equal(completed.approved, true);
  assert.ok(callbackPayload);
  assert.ok(!JSON.stringify(callbackPayload).includes('owner_approval_jws'));
  const handle = String(callbackPayload!['owner_approval_handle']);
  const jws = decryptHeyGenOwnerApprovalHandle(handle, packet.operation_id, HANDLE, NOW);
  const claims = verifyHeyGenAvatarVideoApproval(jws, {
    operationId: packet.operation_id,
    requestSha256: packet.request_sha256,
    idempotencyKeySha256: packet.idempotency_key_sha256,
    manifestSha256: packet.manifest_sha256,
    billingSnapshotSha256: packet.billing_snapshot_sha256,
    billingStateSha256: packet.billing_state_sha256,
    billingObservedAt: packet.billing_observed_at,
    confirmedPremiumCreditsBefore: packet.confirmed_premium_credits_before,
    reserveCredits: packet.reserve_credits,
    maxCredits: packet.max_credits,
  }, NOW, {
    issuer: process.env.HEYGEN_OWNER_APPROVAL_ISSUER!, audience: process.env.HEYGEN_OWNER_APPROVAL_AUDIENCE!,
    subject: process.env.HEYGEN_OWNER_APPROVAL_SUBJECT!, jwk: publicJwk,
  });
  assert.equal(claims.operation_id, packet.operation_id);
  await app.close();
});

test('approval broker rejects reserve drift and a non-owner OTP identity', async () => {
  env();
  const app = Fastify({ logger: false });
  registerHeyGenApprovalBrokerRoutes(app, {
    now: () => NOW,
    random: fixedRandom,
    startOtp: async () => ({ maskedEmail: 'm***@otchealthmart.com' }),
    verifyOtp: async () => ({ email: 'other@example.com', loginIds: ['other@example.com'], verifiedEmail: true }),
    callback: async () => { throw new Error('must not callback'); },
  });
  const bad = createHeyGenApprovalContextToken({ ...packet, reserve_credits: 587 }, CONTEXT, NOW, 600);
  const refused = await app.inject({ method: 'POST', url: '/v1/heygen/avatar-video/start', payload: { context_token: bad.token } });
  assert.equal(refused.statusCode, 409);

  const context = createHeyGenApprovalContextToken(packet, CONTEXT, NOW, 600);
  const start = await app.inject({ method: 'POST', url: '/v1/heygen/avatar-video/start', payload: { context_token: context.token } });
  const complete = await app.inject({ method: 'POST', url: '/v1/heygen/avatar-video/complete', payload: { challenge_token: start.json().challenge_token, code: '123456' } });
  assert.equal(complete.statusCode, 401);
  await app.close();
});

test('approval broker health proves matching key configuration without exposing private material', async () => {
  env();
  const app = Fastify({ logger: false });
  registerHeyGenApprovalBrokerRoutes(app, {
    now: () => NOW, random: fixedRandom,
    startOtp: async () => ({}), verifyOtp: async () => ({ loginIds: [] }), callback: async () => undefined,
  });
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.key_id, 'heygen-owner-2026-01');
  assert.match(body.public_jwk_fingerprint_sha256, /^[a-f0-9]{64}$/);
  assert.equal(body.approval_compatibility.public_jwk_sha256, body.public_jwk_fingerprint_sha256);
  for (const key of ['context_secret_sha256', 'handle_secret_sha256', 'callback_secret_sha256']) {
    assert.match(body.approval_compatibility[key], /^[a-f0-9]{64}$/);
  }
  assert.ok(!JSON.stringify(body).includes(String(privateJwk.d)));
  await app.close();
});
