import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHeyGenReferenceLookPlan,
  buildReferenceLookPreflightEvidence,
  parseHeyGenBillingSnapshot,
  type HeyGenReferenceLookCreateInput,
} from './look-contracts.js';

function valid(overrides: Partial<HeyGenReferenceLookCreateInput> = {}): HeyGenReferenceLookCreateInput {
  return {
    operationId: 'look_op_01',
    idempotencyKey: 'look-op:01',
    sourceAvatarId: 'look_source',
    destinationGroupId: 'group_1',
    name: 'OTCH Family Story - Kimberly',
    prompt: 'Photorealistic horizontal documentary portrait.',
    referenceAssetIds: ['asset_1', 'asset_2'],
    confirmedBillingSnapshotSha256: 'a'.repeat(64),
    confirmedBillingStateSha256: 'b'.repeat(64),
    confirmedBillingObservedAt: '2026-08-10T00:00:00Z',
    reservePremiumCredits: 100,
    ownerApprovalJws: 'not-used-by-contract-builder',
    confirmCreditUse: true,
    ...overrides,
  };
}

test('reference-conditioned Look plan emits the exact official prompt-avatar body and one-credit packet', () => {
  const plan = buildHeyGenReferenceLookPlan(valid());
  assert.deepEqual(plan.body, {
    type: 'prompt',
    name: 'OTCH Family Story - Kimberly',
    prompt: 'Photorealistic horizontal documentary portrait.',
    avatar_id: 'look_source',
    avatar_group_id: 'group_1',
    reference_images: [
      { type: 'asset_id', asset_id: 'asset_1' },
      { type: 'asset_id', asset_id: 'asset_2' },
    ],
  });
  assert.equal(plan.publishedCostCredits, 1);
  assert.equal(plan.approvalClaims.max_credits, 1);
  assert.equal(plan.approvalClaims.request_sha256, plan.requestSha256);
  assert.match(plan.requestSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.promptSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.idempotencyKeySha256, /^[a-f0-9]{64}$/);
});

test('reference-conditioned Look plan rejects identity, length, asset, and hash drift inputs', () => {
  for (const input of [
    valid({ operationId: 'short' }),
    valid({ idempotencyKey: 'bad key' }),
    valid({ sourceAvatarId: '../escape' }),
    valid({ destinationGroupId: 'group/escape' }),
    valid({ name: 'x'.repeat(101) }),
    valid({ prompt: 'x'.repeat(1001) }),
    valid({ referenceAssetIds: ['a', 'b', 'c', 'd'] }),
    valid({ referenceAssetIds: ['same', 'same'] }),
    valid({ referenceAssetIds: ['../escape'] }),
    valid({ confirmedBillingSnapshotSha256: 'A'.repeat(64) }),
    valid({ confirmedBillingStateSha256: 'A'.repeat(64) }),
    valid({ confirmedBillingObservedAt: 'not-a-date' }),
    valid({ reservePremiumCredits: -1 }),
  ]) assert.throws(() => buildHeyGenReferenceLookPlan(input));
});

test('billing snapshot binds account, plan, both pools, reset times, and observation time', () => {
  const snapshot = parseHeyGenBillingSnapshot({
    data: {
      billing_type: 'subscription',
      username: 'account_1',
      subscription: {
        plan: 'creator',
        credits: {
          premium_credits: { remaining: 981, resets_at: '2026-09-08T19:24:42Z' },
          add_on_credits: { remaining: 7, resets_at: '2026-09-09T00:00:00Z' },
        },
      },
    },
  }, '2026-08-10T00:00:00Z');
  assert.equal(snapshot.premium.remaining, 981);
  assert.equal(snapshot.add_on.remaining, 7);
  assert.equal(snapshot.observed_at, '2026-08-10T00:00:00Z');
  assert.match(snapshot.state_sha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.snapshot_sha256, /^[a-f0-9]{64}$/);
  const changed = parseHeyGenBillingSnapshot({
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
  }, '2026-08-10T00:00:00Z');
  assert.notEqual(changed.snapshot_sha256, snapshot.snapshot_sha256);
});

test('reference Look preflight requires source-group identity match but records pending consent separately', () => {
  const pending = buildReferenceLookPreflightEvidence({
    source: { id: 'look_source', groupId: 'group_1', status: 'completed' },
    group: { id: 'group_1', status: 'pending_consent', consentStatus: 'pending' },
    destinationGroupId: 'group_1',
    referenceAssetIds: ['asset_1'],
  });
  assert.equal(pending.consent_accepted, false);
  assert.equal(pending.reference_assets_verified, true);
  const accepted = buildReferenceLookPreflightEvidence({
    source: { id: 'look_source', groupId: 'group_1', status: 'completed' },
    group: { id: 'group_1', status: 'completed', consentStatus: 'accepted' },
    destinationGroupId: 'group_1',
    referenceAssetIds: [],
  });
  assert.equal(accepted.consent_accepted, true);
  assert.throws(() => buildReferenceLookPreflightEvidence({
    source: { id: 'look_source', groupId: 'group_2', status: 'completed' },
    group: { id: 'group_1', status: 'completed', consentStatus: 'accepted' },
    destinationGroupId: 'group_1',
    referenceAssetIds: [],
  }));
});
