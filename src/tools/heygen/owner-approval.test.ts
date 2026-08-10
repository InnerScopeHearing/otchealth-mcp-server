import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import {
  consumeHeyGenOwnerApproval,
  heyGenApprovalJtiSha256,
  verifyHeyGenAvatarVideoApproval,
  verifyHeyGenReferenceLookApproval,
  type HeyGenApprovalVerificationConfig,
} from './owner-approval.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
jwk.kid = 'key-1';
const config: HeyGenApprovalVerificationConfig = {
  issuer: 'https://approval.test',
  audience: 'otchealth-heygen',
  subject: 'matt-owner-id',
  jwk,
};
const NOW_MS = 1_800_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);

function enc(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function grant(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
  const header = enc({ alg: 'ES256', typ: 'OTC-HeyGen-Approval+jwt', kid: 'key-1', ...headerOverrides });
  const claims = enc({
    iss: config.issuer,
    aud: config.audience,
    sub: config.subject,
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    jti: 'grant-id-0001',
    grant_type: 'heygen_reference_look_create',
    tool: 'heygen_reference_look_create',
    operation_id: 'look_op_01',
    request_sha256: 'a'.repeat(64),
    billing_snapshot_sha256: 'b'.repeat(64),
    billing_state_sha256: 'e'.repeat(64),
    billing_observed_at: '2026-08-10T00:00:00Z',
    confirmed_premium_credits_before: 591,
    reserve_credits: 100,
    max_credits: 1,
    ...overrides,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`, 'ascii'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

function videoGrant(maxCredits = 5): string {
  const header = enc({ alg: 'ES256', typ: 'OTC-HeyGen-Approval+jwt', kid: 'key-1' });
  const payload = enc({
    iss: config.issuer,
    aud: config.audience,
    sub: config.subject,
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    jti: 'video-grant-0001',
    grant_type: 'heygen_avatar_video_create',
    tool: 'heygen_avatar_video_create',
    operation_id: 'video_op_01',
    request_sha256: 'c'.repeat(64),
    billing_snapshot_sha256: 'd'.repeat(64),
    billing_state_sha256: 'f'.repeat(64),
    billing_observed_at: '2026-08-10T00:00:00Z',
    confirmed_premium_credits_before: 591,
    reserve_credits: 100,
    max_credits: maxCredits,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const expected = {
  operationId: 'look_op_01',
  requestSha256: 'a'.repeat(64),
  billingSnapshotSha256: 'b'.repeat(64),
  billingStateSha256: 'e'.repeat(64),
  billingObservedAt: '2026-08-10T00:00:00Z',
  confirmedPremiumCreditsBefore: 591,
  reserveCredits: 100,
};

test('owner grant verifier accepts one exact ES256 grant bound to operation, request, billing, and one credit', () => {
  const claims = verifyHeyGenReferenceLookApproval(grant(), expected, NOW_MS, config);
  assert.equal(claims.sub, config.subject);
  assert.equal(claims.max_credits, 1);
  assert.equal(claims.operation_id, expected.operationId);
  assert.match(heyGenApprovalJtiSha256(claims.jti), /^[a-f0-9]{64}$/);
});

test('Avatar Video owner grant binds the exact request, billing snapshot, and credit ceiling', () => {
  const claims = verifyHeyGenAvatarVideoApproval(videoGrant(5), {
    operationId: 'video_op_01',
    requestSha256: 'c'.repeat(64),
    billingSnapshotSha256: 'd'.repeat(64),
    billingStateSha256: 'f'.repeat(64),
    billingObservedAt: '2026-08-10T00:00:00Z',
    confirmedPremiumCreditsBefore: 591,
    reserveCredits: 100,
    maxCredits: 5,
  }, NOW_MS, config);
  assert.equal(claims.grant_type, 'heygen_avatar_video_create');
  assert.equal(claims.max_credits, 5);
  assert.throws(() => verifyHeyGenAvatarVideoApproval(videoGrant(5), {
    operationId: 'video_op_01',
    requestSha256: 'c'.repeat(64),
    billingSnapshotSha256: 'd'.repeat(64),
    billingStateSha256: 'f'.repeat(64),
    billingObservedAt: '2026-08-10T00:00:00Z',
    confirmedPremiumCreditsBefore: 591,
    reserveCredits: 100,
    maxCredits: 6,
  }, NOW_MS, config));
});

test('owner grant verifier rejects algorithm, key, principal, time, and binding drift', () => {
  for (const token of [
    grant({}, { alg: 'none' }),
    grant({}, { kid: 'unknown' }),
    grant({ sub: 'different-owner' }),
    grant({ aud: 'different-audience' }),
    grant({ exp: NOW - 60 }),
    grant({ exp: NOW + 700 }),
    grant({ max_credits: 2 }),
    grant({ operation_id: 'look_op_02' }),
    grant({ request_sha256: 'c'.repeat(64) }),
    grant({ billing_snapshot_sha256: 'd'.repeat(64) }),
    grant({ billing_state_sha256: 'd'.repeat(64) }),
    grant({ confirmed_premium_credits_before: 590 }),
    grant({ reserve_credits: 0 }),
  ]) {
    assert.throws(() => verifyHeyGenReferenceLookApproval(token, expected, NOW_MS, config));
  }
  const tampered = grant().split('.');
  tampered[1] = enc({ hello: 'tampered' });
  assert.throws(() => verifyHeyGenReferenceLookApproval(tampered.join('.'), expected, NOW_MS, config));
});

test('owner grant consumption stores only bounded hashes and refuses replay', async () => {
  const claims = verifyHeyGenReferenceLookApproval(grant(), expected, NOW_MS, config);
  const docs: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const deps = {
    now: () => NOW_MS,
    create: async (_container: string, id: string, doc: Record<string, unknown>) => {
      if (seen.has(id)) throw new Error('conflict');
      seen.add(id);
      docs.push(doc);
      return { ok: true, status: 201, body: doc, etag: 'E1' };
    },
  };
  const first = await consumeHeyGenOwnerApproval(claims, deps);
  assert.match(first.grant_id_sha256, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(docs);
  assert.equal(serialized.includes(claims.jti), false);
  assert.equal(serialized.includes('eyJ'), false);
  await assert.rejects(() => consumeHeyGenOwnerApproval(claims, deps), /already consumed|could not be fenced/);
});
