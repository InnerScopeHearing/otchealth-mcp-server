import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeyGenApprovalContextToken, verifyHeyGenApprovalContextToken } from './approval-context.js';

const SECRET = 'context-secret-with-at-least-thirty-two-bytes';
const NOW = 1_800_000_000_000;
const packet = {
  grant_type: 'heygen_avatar_video_create',
  tool: 'heygen_avatar_video_create',
  operation_id: 'video_op_01',
  request_sha256: 'a'.repeat(64),
  idempotency_key_sha256: 'b'.repeat(64),
  manifest_sha256: 'c'.repeat(64),
  billing_snapshot_sha256: 'd'.repeat(64),
  billing_state_sha256: 'e'.repeat(64),
  billing_observed_at: '2027-01-15T08:00:00.000Z',
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

test('approval context binds the exact packet, hash, lifetime, and HMAC', () => {
  const issued = createHeyGenApprovalContextToken(packet, SECRET, NOW, 300);
  const verified = verifyHeyGenApprovalContextToken(issued.token, SECRET, NOW + 60_000);
  assert.deepEqual(verified.packet, packet);
  assert.equal(verified.packetSha256, issued.packetSha256);
  assert.match(issued.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const last = issued.token.at(-1)!;
  const tampered = `${issued.token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  assert.throws(() => verifyHeyGenApprovalContextToken(tampered, SECRET, NOW), /signature/);
  assert.throws(() => verifyHeyGenApprovalContextToken(issued.token, SECRET, NOW + 400_000), /expired/);
});

test('approval context refuses malformed or non-conservative packets', () => {
  assert.throws(() => createHeyGenApprovalContextToken({ ...packet, max_credits: 0 }, SECRET, NOW));
  assert.throws(() => createHeyGenApprovalContextToken({ ...packet, provider_credit_cap_available: true }, SECRET, NOW));
  assert.throws(() => createHeyGenApprovalContextToken(packet, 'short', NOW));
});
