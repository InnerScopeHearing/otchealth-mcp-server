import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJsonSha256, isHeyGenConsentAccepted } from './video-contracts.js';

export const HEYGEN_REFERENCE_LOOK_COST_CREDITS = 1;
export const HEYGEN_REFERENCE_LOOK_OPERATION_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const HEYGEN_REFERENCE_LOOK_IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
export const HEYGEN_REFERENCE_LOOK_SHA256_RE = /^[a-f0-9]{64}$/;
export const HEYGEN_REFERENCE_LOOK_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;

export interface HeyGenBillingPool {
  remaining: number | null;
  resets_at: string | null;
}

export interface HeyGenBillingSnapshot {
  account_id: string;
  billing_type: 'subscription';
  plan: string;
  premium: HeyGenBillingPool;
  add_on: HeyGenBillingPool;
  observed_at: string;
  state_sha256: string;
  snapshot_sha256: string;
}

const AccountSchema = z.object({
  data: z.object({
    billing_type: z.literal('subscription'),
    username: z.string().min(1),
    subscription: z.object({
      plan: z.string().min(1),
      credits: z.object({
        premium_credits: z.object({
          remaining: z.number().int().nonnegative(),
          resets_at: z.string().min(1).nullable().optional(),
        }).passthrough(),
        add_on_credits: z.object({
          remaining: z.number().int().nonnegative().nullable().optional(),
          resets_at: z.string().min(1).nullable().optional(),
        }).passthrough().optional().default({}),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export function parseHeyGenBillingSnapshot(value: unknown, observedAt: string): HeyGenBillingSnapshot {
  const data = AccountSchema.parse(value).data;
  const base = {
    account_id: data.username,
    billing_type: 'subscription' as const,
    plan: data.subscription.plan,
    premium: {
      remaining: data.subscription.credits.premium_credits.remaining,
      resets_at: data.subscription.credits.premium_credits.resets_at ?? null,
    },
    add_on: {
      remaining: data.subscription.credits.add_on_credits.remaining ?? null,
      resets_at: data.subscription.credits.add_on_credits.resets_at ?? null,
    },
    observed_at: observedAt,
  };
  const state = {
    account_id: base.account_id,
    billing_type: base.billing_type,
    plan: base.plan,
    premium: base.premium,
    add_on: base.add_on,
  };
  return {
    ...base,
    state_sha256: canonicalJsonSha256(state),
    snapshot_sha256: canonicalJsonSha256(base),
  };
}

export interface HeyGenReferenceLookCreateInput {
  operationId: string;
  idempotencyKey: string;
  sourceAvatarId: string;
  destinationGroupId: string;
  name: string;
  prompt: string;
  referenceAssetIds: string[];
  confirmedBillingSnapshotSha256?: string;
  confirmedBillingStateSha256?: string;
  confirmedBillingObservedAt?: string;
  reservePremiumCredits: number;
  ownerApprovalJws?: string;
  confirmCreditUse: boolean;
}

export interface HeyGenReferenceLookProviderBody extends Record<string, unknown> {
  type: 'prompt';
  name: string;
  prompt: string;
  avatar_id: string;
  avatar_group_id: string;
  reference_images?: Array<{ type: 'asset_id'; asset_id: string }>;
}

export interface HeyGenReferenceLookPlan {
  body: HeyGenReferenceLookProviderBody;
  requestSha256: string;
  promptSha256: string;
  idempotencyKeySha256: string;
  publishedCostCredits: 1;
  approvalClaims: {
    tool: 'heygen_reference_look_create';
    operation_id: string;
    request_sha256: string;
    billing_snapshot_sha256: string | null;
    max_credits: 1;
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function strictText(value: string, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new Error(`${label} must be ${min}-${max} characters.`);
  }
  return value.trim();
}

export function buildHeyGenReferenceLookPlan(input: HeyGenReferenceLookCreateInput): HeyGenReferenceLookPlan {
  if (!HEYGEN_REFERENCE_LOOK_OPERATION_RE.test(input.operationId)) throw new Error('operation_id is invalid.');
  if (!HEYGEN_REFERENCE_LOOK_IDEMPOTENCY_RE.test(input.idempotencyKey)) throw new Error('idempotency_key is invalid.');
  if (!HEYGEN_REFERENCE_LOOK_ID_RE.test(input.sourceAvatarId)) throw new Error('source_avatar_id is invalid.');
  if (!HEYGEN_REFERENCE_LOOK_ID_RE.test(input.destinationGroupId)) throw new Error('destination_group_id is invalid.');
  if (input.confirmedBillingSnapshotSha256 && !HEYGEN_REFERENCE_LOOK_SHA256_RE.test(input.confirmedBillingSnapshotSha256)) {
    throw new Error('confirmed_billing_snapshot_sha256 must be lowercase SHA-256.');
  }
  if (input.confirmedBillingStateSha256 && !HEYGEN_REFERENCE_LOOK_SHA256_RE.test(input.confirmedBillingStateSha256)) {
    throw new Error('confirmed_billing_state_sha256 must be lowercase SHA-256.');
  }
  if (input.confirmedBillingObservedAt && !Number.isFinite(Date.parse(input.confirmedBillingObservedAt))) {
    throw new Error('confirmed_billing_observed_at must be an ISO timestamp.');
  }
  if (!Number.isInteger(input.reservePremiumCredits) || input.reservePremiumCredits < 0) {
    throw new Error('reserve_premium_credits is invalid.');
  }
  const name = strictText(input.name, 'name', 1, 100);
  const prompt = strictText(input.prompt, 'prompt', 1, 1000);
  if (!Array.isArray(input.referenceAssetIds) || input.referenceAssetIds.length > 3) {
    throw new Error('reference_asset_ids accepts at most 3 items.');
  }
  const seen = new Set<string>();
  for (const id of input.referenceAssetIds) {
    if (!HEYGEN_REFERENCE_LOOK_ID_RE.test(id)) throw new Error('reference_asset_ids contains an invalid id.');
    if (seen.has(id)) throw new Error('reference_asset_ids must be unique.');
    seen.add(id);
  }
  const body: HeyGenReferenceLookProviderBody = {
    type: 'prompt',
    name,
    prompt,
    avatar_id: input.sourceAvatarId,
    avatar_group_id: input.destinationGroupId,
  };
  if (input.referenceAssetIds.length > 0) {
    body.reference_images = input.referenceAssetIds.map((assetId) => ({ type: 'asset_id', asset_id: assetId }));
  }
  const requestSha256 = canonicalJsonSha256(body);
  return {
    body,
    requestSha256,
    promptSha256: hash(prompt),
    idempotencyKeySha256: hash(input.idempotencyKey),
    publishedCostCredits: HEYGEN_REFERENCE_LOOK_COST_CREDITS,
    approvalClaims: {
      tool: 'heygen_reference_look_create',
      operation_id: input.operationId,
      request_sha256: requestSha256,
      billing_snapshot_sha256: input.confirmedBillingSnapshotSha256 ?? null,
      max_credits: HEYGEN_REFERENCE_LOOK_COST_CREDITS,
    },
  };
}

export interface HeyGenReferenceLookPreflightEvidence {
  source_avatar_id: string;
  source_group_id: string;
  destination_group_id: string;
  source_status: string | null;
  group_status: string | null;
  consent_status: string | null;
  consent_accepted: boolean;
  reference_asset_ids: string[];
  reference_assets_verified: boolean;
}

export function buildReferenceLookPreflightEvidence(args: {
  source: { id: string; groupId: string | null; status: string | null };
  group: { id: string; status: string | null; consentStatus: string | null };
  destinationGroupId: string;
  referenceAssetIds: string[];
}): HeyGenReferenceLookPreflightEvidence {
  if (!args.source.groupId || args.source.groupId !== args.destinationGroupId) {
    throw new Error('source_avatar_id must belong to destination_group_id.');
  }
  if (args.group.id !== args.destinationGroupId) throw new Error('destination group lookup mismatch.');
  if (args.source.status && args.source.status !== 'completed') {
    throw new Error(`source avatar look is not completed (${args.source.status}).`);
  }
  if (args.group.status && !['completed', 'pending_consent'].includes(args.group.status)) {
    throw new Error(`destination avatar group is not usable (${args.group.status}).`);
  }
  return {
    source_avatar_id: args.source.id,
    source_group_id: args.source.groupId,
    destination_group_id: args.destinationGroupId,
    source_status: args.source.status,
    group_status: args.group.status,
    consent_status: args.group.consentStatus,
    consent_accepted: isHeyGenConsentAccepted(args.group.consentStatus),
    reference_asset_ids: [...args.referenceAssetIds],
    reference_assets_verified: true,
  };
}
