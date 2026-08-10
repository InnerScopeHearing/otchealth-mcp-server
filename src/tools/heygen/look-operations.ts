import { z } from 'zod';
import {
  getHeyGenAccessToken,
  heyGenApiGet,
  heyGenApiPost,
  HeyGenBrokerError,
  type HeyGenBrokerDeps,
  type HeyGenRawResponse,
} from './broker.js';
import {
  buildHeyGenReferenceLookPlan,
  buildReferenceLookPreflightEvidence,
  parseHeyGenBillingSnapshot,
  type HeyGenBillingSnapshot,
  type HeyGenReferenceLookCreateInput,
  type HeyGenReferenceLookPlan,
} from './look-contracts.js';
import { safeHeyGenAssetMetadata } from './metadata.js';
import {
  consumeHeyGenOwnerApproval,
  verifyHeyGenReferenceLookApproval,
} from './owner-approval.js';
import { parseHeyGenAvatarGroup, parseHeyGenAvatarLook } from './video-contracts.js';
import {
  reserveHeyGenSpend,
  settleHeyGenSpend,
  type HeyGenSpendReservation,
} from './spend-controller.js';

const CACHE_CONTAINER = 'cache';
const OPERATION_TTL = -1;
const CLAIM_LEASE_MS = 60_000;
const MAX_BILLING_SNAPSHOT_AGE_MS = 10 * 60_000;

export type HeyGenReferenceLookOperationState =
  | 'prepared'
  | 'submitting'
  | 'accepted'
  | 'rejected'
  | 'outcome_unknown';

export interface HeyGenReferenceLookOperationDoc extends Record<string, unknown> {
  id: string;
  cacheScope: string;
  ttl: -1;
  kind: 'heygen_reference_look_operation';
  version: 1;
  operationId: string;
  requestSha256: string;
  promptSha256: string;
  idempotencyKeySha256: string;
  sourceAvatarId: string;
  destinationGroupId: string;
  referenceAssetIds: string[];
  confirmedBillingSnapshotSha256: string;
  confirmedBillingStateSha256: string;
  confirmedBillingObservedAt: string;
  confirmedPremiumCreditsBefore: number;
  reservePremiumCredits: number;
  expectedCredits: 1;
  state: HeyGenReferenceLookOperationState;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  submissionStartedAt?: string;
  providerLookId?: string;
  providerGroupId?: string;
  providerStatus?: string;
  upstreamStatus?: number;
  grantIdSha256?: string;
  billingBeforeSha256?: string;
  billingAfterSha256?: string;
  premiumCreditsBefore?: number | null;
  premiumCreditsAfter?: number | null;
  actualCreditDelta?: number | null;
  verificationStatus?: 'verified' | 'pending' | 'failed';
  lastErrorCode?: string;
}

export interface HeyGenReferenceLookOperationResult {
  operation_id: string;
  state: HeyGenReferenceLookOperationState | 'in_progress';
  replayed: boolean;
  request_sha256: string;
  provider_look_id?: string;
  provider_group_id?: string;
  provider_status?: string;
  published_cost_credits: 1;
  premium_credits_before?: number | null;
  premium_credits_after?: number | null;
  actual_credit_delta?: number | null;
  verification_status?: 'verified' | 'pending' | 'failed';
  error_code?: string;
}

const CreateAvatarResponseSchema = z.object({
  data: z.object({
    avatar_item: z.object({
      id: z.string().min(1),
      group_id: z.string().min(1).nullable().optional(),
      status: z.string().nullable().optional(),
    }).passthrough().nullable().optional(),
    avatar_group: z.object({ id: z.string().min(1) }).passthrough().nullable().optional(),
  }).passthrough(),
}).passthrough();

function operationId(operationId: string): string {
  return `heygen.reference-look.${operationId}`;
}

function error(code: string, message: string, status = 409): HeyGenBrokerError {
  return new HeyGenBrokerError(code, message, status);
}

function isOperationDoc(value: unknown): value is HeyGenReferenceLookOperationDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<HeyGenReferenceLookOperationDoc>;
  return doc.kind === 'heygen_reference_look_operation' && doc.version === 1 &&
    doc.ttl === -1 && typeof doc.operationId === 'string' && typeof doc.requestSha256 === 'string' &&
    ['prepared', 'submitting', 'accepted', 'rejected', 'outcome_unknown'].includes(String(doc.state));
}

function view(doc: HeyGenReferenceLookOperationDoc, replayed: boolean, nowMs: number): HeyGenReferenceLookOperationResult {
  const active = doc.state === 'submitting' && Boolean(doc.leaseExpiresAt) && Date.parse(doc.leaseExpiresAt!) > nowMs;
  return {
    operation_id: doc.operationId,
    state: active ? 'in_progress' : doc.state,
    replayed,
    request_sha256: doc.requestSha256,
    provider_look_id: doc.providerLookId,
    provider_group_id: doc.providerGroupId,
    provider_status: doc.providerStatus,
    published_cost_credits: 1,
    premium_credits_before: doc.premiumCreditsBefore,
    premium_credits_after: doc.premiumCreditsAfter,
    actual_credit_delta: doc.actualCreditDelta,
    verification_status: doc.verificationStatus,
    error_code: doc.lastErrorCode,
  };
}

function assertApprovalInputs(input: HeyGenReferenceLookCreateInput): asserts input is HeyGenReferenceLookCreateInput & {
  confirmedBillingSnapshotSha256: string;
  confirmedBillingStateSha256: string;
  confirmedBillingObservedAt: string;
  confirmedPremiumCreditsBefore: number;
  ownerApprovalJws: string;
} {
  if (input.confirmCreditUse !== true) throw error('heygen_credit_confirmation_required', 'confirm_credit_use=true is required.', 400);
  if (!input.ownerApprovalJws) throw error('heygen_owner_approval_required', 'A server-issued owner_approval_jws is required.', 400);
  if (!input.confirmedBillingSnapshotSha256 || !input.confirmedBillingStateSha256 || !input.confirmedBillingObservedAt ||
      input.confirmedPremiumCreditsBefore === undefined) {
    throw error('heygen_billing_snapshot_required', 'The exact dry-run billing snapshot, state hash, observation time, and premium balance are required.', 400);
  }
}

function assertSame(doc: HeyGenReferenceLookOperationDoc, input: HeyGenReferenceLookCreateInput, plan: HeyGenReferenceLookPlan): void {
  const same = doc.requestSha256 === plan.requestSha256 &&
    doc.promptSha256 === plan.promptSha256 &&
    doc.idempotencyKeySha256 === plan.idempotencyKeySha256 &&
    doc.sourceAvatarId === input.sourceAvatarId &&
    doc.destinationGroupId === input.destinationGroupId &&
    JSON.stringify(doc.referenceAssetIds) === JSON.stringify(input.referenceAssetIds) &&
    doc.confirmedBillingSnapshotSha256 === input.confirmedBillingSnapshotSha256 &&
    doc.confirmedBillingStateSha256 === input.confirmedBillingStateSha256 &&
    doc.confirmedBillingObservedAt === input.confirmedBillingObservedAt &&
    doc.confirmedPremiumCreditsBefore === input.confirmedPremiumCreditsBefore &&
    doc.reservePremiumCredits === input.reservePremiumCredits;
  if (!same) throw error('heygen_reference_look_idempotency_conflict', 'operation_id is already bound to a different Look request, billing snapshot, or provider key.');
}

async function readOperation(operation: string, deps: HeyGenBrokerDeps): Promise<{ doc: HeyGenReferenceLookOperationDoc; etag: string } | null> {
  const id = operationId(operation);
  const row = await deps.read(CACHE_CONTAINER, id, id);
  if (!row) return null;
  if (!row.etag || !isOperationDoc(row.doc)) throw error('heygen_reference_look_operation_invalid', 'Stored Look operation is invalid.');
  return { doc: row.doc, etag: row.etag };
}

async function ensureOperation(
  input: HeyGenReferenceLookCreateInput & {
    confirmedBillingSnapshotSha256: string;
    confirmedBillingStateSha256: string;
    confirmedBillingObservedAt: string;
    confirmedPremiumCreditsBefore: number;
  },
  plan: HeyGenReferenceLookPlan,
  deps: HeyGenBrokerDeps,
): Promise<{ doc: HeyGenReferenceLookOperationDoc; etag: string }> {
  const existing = await readOperation(input.operationId, deps);
  if (existing) {
    assertSame(existing.doc, input, plan);
    return existing;
  }
  const id = operationId(input.operationId);
  const now = new Date(deps.now()).toISOString();
  const doc: HeyGenReferenceLookOperationDoc = {
    id,
    cacheScope: id,
    ttl: OPERATION_TTL,
    kind: 'heygen_reference_look_operation',
    version: 1,
    operationId: input.operationId,
    requestSha256: plan.requestSha256,
    promptSha256: plan.promptSha256,
    idempotencyKeySha256: plan.idempotencyKeySha256,
    sourceAvatarId: input.sourceAvatarId,
    destinationGroupId: input.destinationGroupId,
    referenceAssetIds: [...input.referenceAssetIds],
    confirmedBillingSnapshotSha256: input.confirmedBillingSnapshotSha256,
    confirmedBillingStateSha256: input.confirmedBillingStateSha256,
    confirmedBillingObservedAt: input.confirmedBillingObservedAt,
    confirmedPremiumCreditsBefore: input.confirmedPremiumCreditsBefore,
    reservePremiumCredits: input.reservePremiumCredits,
    expectedCredits: 1,
    state: 'prepared',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const created = await deps.create(CACHE_CONTAINER, id, doc);
    if (!created.etag) throw new Error('missing etag');
    return { doc, etag: created.etag };
  } catch {
    const winner = await readOperation(input.operationId, deps);
    if (!winner) throw error('heygen_reference_look_operation_store_unavailable', 'Could not create the Look operation.', 503);
    assertSame(winner.doc, input, plan);
    return winner;
  }
}

async function replaceOperation(
  current: { doc: HeyGenReferenceLookOperationDoc; etag: string },
  changes: Partial<HeyGenReferenceLookOperationDoc>,
  deps: HeyGenBrokerDeps,
): Promise<{ doc: HeyGenReferenceLookOperationDoc; etag: string } | null> {
  const next: HeyGenReferenceLookOperationDoc = {
    ...current.doc,
    ...changes,
    id: current.doc.id,
    cacheScope: current.doc.cacheScope,
    updatedAt: new Date(deps.now()).toISOString(),
  };
  const result = await deps.replace(CACHE_CONTAINER, next.cacheScope, next.id, next, current.etag);
  if (result.status === 412) return null;
  if (!result.ok || !result.etag) throw error('heygen_reference_look_operation_store_unavailable', 'Could not persist the Look operation.', 503);
  return { doc: next, etag: result.etag };
}

function requireOk(response: HeyGenRawResponse, code: string, label: string): HeyGenRawResponse {
  if (!response.ok) throw error(code, `${label} failed (HTTP ${response.status}).`, response.status === 401 ? 401 : 409);
  return response;
}

async function finalBilling(accessToken: string, deps: HeyGenBrokerDeps): Promise<HeyGenBillingSnapshot> {
  const response = requireOk(
    await heyGenApiGet('/v3/users/me', accessToken, {}, deps),
    'heygen_reference_look_account_failed',
    'HeyGen subscription guard',
  );
  return parseHeyGenBillingSnapshot(response.body, new Date(deps.now()).toISOString());
}

function responseAvatar(value: unknown): { lookId: string; groupId: string | null; status: string | null } {
  const data = CreateAvatarResponseSchema.parse(value).data;
  if (!data.avatar_item?.id) throw new Error('missing avatar_item.id');
  return {
    lookId: data.avatar_item.id,
    groupId: data.avatar_item.group_id ?? data.avatar_group?.id ?? null,
    status: data.avatar_item.status ?? null,
  };
}

export async function getHeyGenReferenceLookOperation(
  operation: string,
  deps: HeyGenBrokerDeps,
): Promise<HeyGenReferenceLookOperationResult | null> {
  const row = await readOperation(operation, deps);
  return row ? view(row.doc, true, deps.now()) : null;
}

export async function executeHeyGenReferenceLookCreate(
  input: HeyGenReferenceLookCreateInput,
  deps: HeyGenBrokerDeps,
): Promise<HeyGenReferenceLookOperationResult> {
  assertApprovalInputs(input);
  const plan = buildHeyGenReferenceLookPlan(input);
  const prepared = await ensureOperation(input, plan, deps);
  if (prepared.doc.state === 'submitting' &&
      (!prepared.doc.leaseExpiresAt || Date.parse(prepared.doc.leaseExpiresAt) <= deps.now())) {
    const unknown = await replaceOperation(prepared, {
      state: 'outcome_unknown',
      lastErrorCode: 'submission_lease_expired',
      leaseExpiresAt: undefined,
    }, deps);
    return view((unknown ?? prepared).doc, true, deps.now());
  }
  if (prepared.doc.state !== 'prepared') return view(prepared.doc, true, deps.now());

  const observedAtMs = Date.parse(input.confirmedBillingObservedAt);
  if (!Number.isFinite(observedAtMs) || deps.now() - observedAtMs > MAX_BILLING_SNAPSHOT_AGE_MS || observedAtMs > deps.now() + 30_000) {
    throw error('heygen_billing_snapshot_stale', 'The approved billing snapshot is stale or from the future. Run a new dry-run.', 409);
  }

  const claimed = await replaceOperation(prepared, {
    state: 'submitting',
    attemptCount: 1,
    submissionStartedAt: new Date(deps.now()).toISOString(),
    leaseExpiresAt: new Date(deps.now() + CLAIM_LEASE_MS).toISOString(),
  }, deps);
  if (!claimed) {
    const winner = await readOperation(input.operationId, deps);
    if (!winner) throw error('heygen_reference_look_operation_store_unavailable', 'Could not resolve the Look operation winner.', 503);
    return view(winner.doc, true, deps.now());
  }

  let current = claimed;
  let spendReservation: HeyGenSpendReservation | null = null;
  let providerMayHaveAccepted = false;
  try {
    const accessToken = await getHeyGenAccessToken({ deps });
    const sourceResponse = requireOk(
      await heyGenApiGet(`/v3/avatars/looks/${input.sourceAvatarId}`, accessToken, {}, deps),
      'heygen_reference_look_source_failed',
      'HeyGen source Look lookup',
    );
    const source = parseHeyGenAvatarLook(sourceResponse.body);
    const groupResponse = requireOk(
      await heyGenApiGet(`/v3/avatars/${input.destinationGroupId}`, accessToken, {}, deps),
      'heygen_reference_look_group_failed',
      'HeyGen destination group lookup',
    );
    const group = parseHeyGenAvatarGroup(groupResponse.body);
    const assetIds: string[] = [];
    for (const assetId of input.referenceAssetIds) {
      const assetResponse = requireOk(
        await heyGenApiGet(`/v3/assets/${assetId}`, accessToken, {}, deps),
        'heygen_reference_look_asset_failed',
        'HeyGen reference asset lookup',
      );
      const asset = safeHeyGenAssetMetadata(assetResponse.body);
      if (asset.id !== assetId) throw error('heygen_reference_look_asset_mismatch', 'HeyGen returned the wrong reference asset.', 502);
      if (asset.type !== 'image') throw error('heygen_reference_look_asset_type_invalid', 'HeyGen reference assets must be images.', 409);
      assetIds.push(asset.id);
    }
    const identityEvidence = buildReferenceLookPreflightEvidence({
      source: { id: source.id, groupId: source.groupId, status: source.status },
      group: { id: group.id, status: group.status, consentStatus: group.consentStatus },
      destinationGroupId: input.destinationGroupId,
      referenceAssetIds: assetIds,
    });
    if (group.status !== 'completed' || !identityEvidence.consent_accepted) {
      throw error(
        'heygen_reference_look_consent_required',
        'Real reference-Look creation requires a completed group with accepted consent. Dry-run preflight remains available.',
        409,
      );
    }

    const before = await finalBilling(accessToken, deps);
    if (before.state_sha256 !== input.confirmedBillingStateSha256 ||
        before.premium.remaining !== input.confirmedPremiumCreditsBefore) {
      throw error('heygen_reference_look_billing_drift', 'HeyGen billing state changed after approval. Run a new dry-run.', 409);
    }
    if ((before.premium.remaining ?? 0) - 1 < input.reservePremiumCredits) {
      throw error('heygen_reference_look_reserve_violation', 'The one-credit Look would reduce the live premium balance below the reserve floor.', 409);
    }
    spendReservation = await reserveHeyGenSpend({
      accountId: before.account_id,
      operationId: input.operationId,
      kind: 'reference_look',
      maxCredits: 1,
      reserveCredits: input.reservePremiumCredits,
      premiumCreditsBefore: before.premium.remaining ?? 0,
      billingStateSha256: before.state_sha256,
    }, deps);
    const claims = verifyHeyGenReferenceLookApproval(input.ownerApprovalJws, {
      operationId: input.operationId,
      requestSha256: plan.requestSha256,
      billingSnapshotSha256: input.confirmedBillingSnapshotSha256,
      billingStateSha256: input.confirmedBillingStateSha256,
      billingObservedAt: input.confirmedBillingObservedAt,
      confirmedPremiumCreditsBefore: input.confirmedPremiumCreditsBefore,
      reserveCredits: input.reservePremiumCredits,
    }, deps.now());
    const consumed = await consumeHeyGenOwnerApproval(claims, deps);
    const withGrant = await replaceOperation(current, {
      grantIdSha256: consumed.grant_id_sha256,
      billingBeforeSha256: before.snapshot_sha256,
      premiumCreditsBefore: before.premium.remaining,
    }, deps);
    if (!withGrant) throw error('heygen_reference_look_operation_race', 'The Look operation changed before submission; no provider request was sent.', 409);
    current = withGrant;

    let response: HeyGenRawResponse;
    try {
      providerMayHaveAccepted = true;
      response = await heyGenApiPost('/v3/avatars', accessToken, plan.body, deps, {
        'Idempotency-Key': input.idempotencyKey,
      });
    } catch {
      const unknown = await replaceOperation(current, {
        state: 'outcome_unknown',
        lastErrorCode: 'transport_ambiguous',
        leaseExpiresAt: undefined,
      }, deps);
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'outcome_unknown', deps);
      return view((unknown ?? current).doc, false, deps.now());
    }
    if (!response.ok) {
      const outcome = response.status >= 500 ? 'outcome_unknown' : 'rejected';
      const rejected = await replaceOperation(current, {
        state: outcome,
        upstreamStatus: response.status,
        lastErrorCode: `http_${response.status}`,
        leaseExpiresAt: undefined,
      }, deps);
      if (spendReservation) await settleHeyGenSpend(spendReservation, outcome, deps);
      return view((rejected ?? current).doc, false, deps.now());
    }

    let created: ReturnType<typeof responseAvatar>;
    try {
      created = responseAvatar(response.body);
    } catch {
      const unknown = await replaceOperation(current, {
        state: 'outcome_unknown',
        upstreamStatus: response.status,
        lastErrorCode: 'invalid_success',
        leaseExpiresAt: undefined,
      }, deps);
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'outcome_unknown', deps);
      return view((unknown ?? current).doc, false, deps.now());
    }

    let verificationStatus: 'verified' | 'pending' | 'failed' = 'pending';
    let after: HeyGenBillingSnapshot | null = null;
    try {
      const createdRaw = requireOk(
        await heyGenApiGet(`/v3/avatars/looks/${created.lookId}`, accessToken, {}, deps),
        'heygen_reference_look_verify_failed',
        'HeyGen created Look verification',
      );
      const createdLook = parseHeyGenAvatarLook(createdRaw.body);
      if (createdLook.id !== created.lookId || createdLook.groupId !== input.destinationGroupId) {
        verificationStatus = 'failed';
      } else {
        verificationStatus = createdLook.status === 'failed' ? 'failed' : createdLook.status === 'completed' ? 'verified' : 'pending';
      }
      after = await finalBilling(accessToken, deps);
    } catch {
      verificationStatus = 'pending';
    }
    const beforeCredits = before.premium.remaining;
    const afterCredits = after?.premium.remaining ?? null;
    const delta = beforeCredits === null || afterCredits === null ? null : beforeCredits - afterCredits;
    const accepted = await replaceOperation(current, {
      state: 'accepted',
      providerLookId: created.lookId,
      providerGroupId: created.groupId ?? input.destinationGroupId,
      providerStatus: created.status ?? undefined,
      upstreamStatus: response.status,
      billingAfterSha256: after?.snapshot_sha256,
      premiumCreditsAfter: afterCredits,
      actualCreditDelta: delta,
      verificationStatus,
      lastErrorCode: delta !== null && delta !== 1 ? 'unexpected_credit_delta' : undefined,
      leaseExpiresAt: undefined,
    }, deps);
    if (accepted) {
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'accepted', deps);
      return view(accepted.doc, false, deps.now());
    }
    const winner = await readOperation(input.operationId, deps);
    if (winner) {
      if (spendReservation) {
        await settleHeyGenSpend(
          spendReservation,
          winner.doc.state === 'accepted' ? 'accepted' : 'outcome_unknown',
          deps,
        );
      }
      return view(winner.doc, true, deps.now());
    }
    if (spendReservation) await settleHeyGenSpend(spendReservation, 'outcome_unknown', deps);
    return view({
      ...current.doc,
      state: 'outcome_unknown',
      providerLookId: created.lookId,
      lastErrorCode: 'accepted_response_persist_race',
      leaseExpiresAt: undefined,
    }, true, deps.now());
  } catch (caught) {
    const terminalState: HeyGenReferenceLookOperationState = providerMayHaveAccepted
      ? 'outcome_unknown'
      : 'rejected';
    const terminal = await replaceOperation(current, {
      state: terminalState,
      lastErrorCode: caught instanceof HeyGenBrokerError
        ? caught.code
        : providerMayHaveAccepted
          ? 'post_submission_failure'
          : 'preflight_or_approval_failed',
      leaseExpiresAt: undefined,
    }, deps).catch(() => null);
    if (spendReservation) {
      await settleHeyGenSpend(spendReservation, terminalState, deps).catch(() => undefined);
    }
    if (terminal) return view(terminal.doc, false, deps.now());
    throw caught;
  }
}
