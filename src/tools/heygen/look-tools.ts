import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { registerTool, type CallerHashProvider, type ToolResultPayload } from '../registry.js';
import {
  executeHeyGenRead,
  HEYGEN_SAFE_ID_RE,
  type HeyGenBrokerDeps,
} from './broker.js';
import { HEYGEN_DATA_LANES } from './access.js';
import {
  buildHeyGenReferenceLookPlan,
  buildReferenceLookPreflightEvidence,
  parseHeyGenBillingSnapshot,
  type HeyGenReferenceLookCreateInput,
} from './look-contracts.js';
import { safeHeyGenAssetMetadata } from './metadata.js';
import { parseHeyGenAvatarGroup, parseHeyGenAvatarLook } from './video-contracts.js';
import { redactHeyGenReferenceLookInputForLog } from './redaction.js';
import {
  executeHeyGenReferenceLookCreate,
  getHeyGenReferenceLookOperation,
} from './look-operations.js';

const SAFE_ID = z.string().regex(HEYGEN_SAFE_ID_RE);

export const HEYGEN_REFERENCE_LOOK_OPERATION_GET_INPUT = {
  operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
} as const;

export const HEYGEN_REFERENCE_LOOK_CREATE_INPUT = {
  operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
  source_avatar_id: SAFE_ID,
  destination_group_id: SAFE_ID,
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(1000),
  reference_asset_ids: z.array(SAFE_ID).max(3).optional(),
  confirmed_billing_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmed_billing_state_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmed_billing_observed_at: z.string().datetime().optional(),
  reserve_premium_credits: z.number().int().min(0),
  owner_approval_jws: z.string().min(64).max(8192).optional(),
  confirm_credit_use: z.boolean().optional(),
} as const;

function refusal(caller: string, dryRun: boolean): ToolResultPayload {
  return {
    data: { error: 'forbidden_lane' },
    summary: dryRun
      ? `Refused: HeyGen reference-Look preflight is available only to internal lanes ${HEYGEN_DATA_LANES.join('/')}. Your identity: ${caller || '(none)'}.`
      : `Refused: live HeyGen reference-Look creation is CTO-only. Your identity: ${caller || '(none)'}.`,
  };
}

function mappedInput(input: Record<string, unknown>, dryRun: boolean): HeyGenReferenceLookCreateInput {
  return {
    operationId: String(input.operation_id),
    idempotencyKey: String(input.idempotency_key),
    sourceAvatarId: String(input.source_avatar_id),
    destinationGroupId: String(input.destination_group_id),
    name: String(input.name),
    prompt: String(input.prompt),
    referenceAssetIds: Array.isArray(input.reference_asset_ids)
      ? input.reference_asset_ids.map(String)
      : [],
    confirmedBillingSnapshotSha256: typeof input.confirmed_billing_snapshot_sha256 === 'string'
      ? input.confirmed_billing_snapshot_sha256
      : undefined,
    confirmedBillingStateSha256: typeof input.confirmed_billing_state_sha256 === 'string'
      ? input.confirmed_billing_state_sha256
      : undefined,
    confirmedBillingObservedAt: typeof input.confirmed_billing_observed_at === 'string'
      ? input.confirmed_billing_observed_at
      : undefined,
    reservePremiumCredits: Number(input.reserve_premium_credits),
    ownerApprovalJws: typeof input.owner_approval_jws === 'string' ? input.owner_approval_jws : undefined,
    confirmCreditUse: dryRun || input.confirm_credit_use === true,
  };
}

export async function prepareHeyGenReferenceLook(
  input: HeyGenReferenceLookCreateInput,
  deps: HeyGenBrokerDeps,
): Promise<Record<string, unknown>> {
  const initial = buildHeyGenReferenceLookPlan(input);
  const accountRaw = await executeHeyGenRead({ kind: 'account' }, deps);
  const billing = parseHeyGenBillingSnapshot(accountRaw, new Date(deps.now()).toISOString());
  const plan = buildHeyGenReferenceLookPlan({
    ...input,
    confirmedBillingSnapshotSha256: billing.snapshot_sha256,
    confirmedBillingStateSha256: billing.state_sha256,
    confirmedBillingObservedAt: billing.observed_at,
  });
  const sourceRaw = await executeHeyGenRead({ kind: 'avatarLook', lookId: input.sourceAvatarId }, deps);
  const source = parseHeyGenAvatarLook(sourceRaw);
  const groupRaw = await executeHeyGenRead({ kind: 'avatarGroup', groupId: input.destinationGroupId }, deps);
  const group = parseHeyGenAvatarGroup(groupRaw);
  const assets = [];
  for (const assetId of input.referenceAssetIds) {
    const assetRaw = await executeHeyGenRead({ kind: 'asset', assetId }, deps);
    const asset = safeHeyGenAssetMetadata(assetRaw);
    if (asset.id !== assetId) throw new Error('HeyGen returned the wrong reference asset.');
    assets.push(asset);
  }
  const evidence = buildReferenceLookPreflightEvidence({
    source: { id: source.id, groupId: source.groupId, status: source.status },
    group: { id: group.id, status: group.status, consentStatus: group.consentStatus },
    destinationGroupId: input.destinationGroupId,
    referenceAssetIds: assets.map((asset) => asset.id),
  });
  if ((billing.premium.remaining ?? 0) - plan.publishedCostCredits < input.reservePremiumCredits) {
    throw new Error('The one-credit Look would reduce the live premium balance below the reserve floor.');
  }
  return {
    mode: 'dry_run',
    provider_mutation: false,
    operation_record_mutation: false,
    operation_id: input.operationId,
    request_sha256: plan.requestSha256,
    prompt_sha256: plan.promptSha256,
    idempotency_key_sha256: plan.idempotencyKeySha256,
    provider_contract: {
      endpoint: 'POST /v3/avatars',
      type: 'prompt',
      source_avatar_id: input.sourceAvatarId,
      destination_group_id: input.destinationGroupId,
      reference_asset_count: input.referenceAssetIds.length,
      prompt_max_chars: 1000,
      one_look_per_operation: true,
      official_idempotency_key: true,
    },
    published_cost_credits: plan.publishedCostCredits,
    maximum_debit_credits: plan.publishedCostCredits,
    billing,
    evidence,
    reference_assets: assets,
    approval_packet: {
      ...plan.approvalClaims,
      billing_snapshot_sha256: billing.snapshot_sha256,
      billing_state_sha256: billing.state_sha256,
      billing_observed_at: billing.observed_at,
      owner_grant_required: true,
      grant_single_use: true,
      grant_max_age_seconds: 600,
      zero_automatic_retries: true,
    },
    notice: 'Dry run validates the exact live account, source Look, destination group, optional assets, request hash, published one-credit cost, and future owner grant. It does not create a Look or prove render quality.',
    initial_request_sha256: initial.requestSha256,
  };
}

export function registerHeyGenLookTools(
  server: McpServer,
  callerHash: CallerHashProvider,
  deps: HeyGenBrokerDeps,
): void {
  registerTool(server, {
    name: 'heygen_reference_look_operation_get',
    category: 'read',
    annotations: {
      title: 'HeyGen: get reference-Look operation',
      description: 'Reads the gateway-owned reference-Look operation and credit reconciliation state. No prompt, owner grant, raw idempotency key, provider body, or signed URL is returned.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: HEYGEN_REFERENCE_LOOK_OPERATION_GET_INPUT,
    outputShape: { found: z.boolean(), operation: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (!(HEYGEN_DATA_LANES as readonly string[]).includes(ctx.callerAgent)) {
        return refusal(ctx.callerAgent, true);
      }
      const operation = await getHeyGenReferenceLookOperation(input.operation_id, deps);
      return {
        data: { found: operation !== null, operation },
        summary: operation
          ? `HeyGen reference-Look operation ${input.operation_id}: ${operation.state}.`
          : `HeyGen reference-Look operation ${input.operation_id} not found.`,
      };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_reference_look_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'HeyGen: create one reference-conditioned Look',
      description: 'Creates one prompt Look from a required source avatar_id in its verified destination group, with up to three existing reference assets. Dry-run performs live read-only preflight. Real creation is CTO-only, feature-gated, subscription-only, one credit, idempotent, owner-approved, and zero-auto-retry.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: HEYGEN_REFERENCE_LOOK_CREATE_INPUT,
    outputShape: {
      mode: z.string().optional(),
      state: z.string().optional(),
      replayed: z.boolean().optional(),
      provider_mutation: z.boolean().optional(),
      operation_record_mutation: z.boolean().optional(),
      operation_id: z.string(),
      request_sha256: z.string(),
      prompt_sha256: z.string().optional(),
      idempotency_key_sha256: z.string().optional(),
      provider_contract: z.unknown().optional(),
      published_cost_credits: z.number().int(),
      maximum_debit_credits: z.number().int().optional(),
      billing: z.unknown().optional(),
      evidence: z.unknown().optional(),
      reference_assets: z.array(z.unknown()).optional(),
      approval_packet: z.unknown().optional(),
      notice: z.string().optional(),
      initial_request_sha256: z.string().optional(),
      provider_look_id: z.string().optional(),
      provider_group_id: z.string().optional(),
      provider_status: z.string().optional(),
      premium_credits_before: z.number().int().nullable().optional(),
      premium_credits_after: z.number().int().nullable().optional(),
      actual_credit_delta: z.number().int().nullable().optional(),
      verification_status: z.string().optional(),
      error_code: z.string().optional(),
      error: z.string().optional(),
    },
    redactInputForLog: redactHeyGenReferenceLookInputForLog,
    shieldInputForScan: (input) => ({ prompt: input.prompt }),
    handler: async (input, ctx) => {
      const internalDryRun = ctx.dryRun && (HEYGEN_DATA_LANES as readonly string[]).includes(ctx.callerAgent);
      const liveCto = !ctx.dryRun && ctx.callerAgent === 'cto';
      if (!internalDryRun && !liveCto) return refusal(ctx.callerAgent, ctx.dryRun);
      const mapped = mappedInput(input as unknown as Record<string, unknown>, ctx.dryRun);
      if (ctx.dryRun) {
        const preflight = await prepareHeyGenReferenceLook(mapped, deps);
        return { data: preflight, summary: 'DRY RUN: live reference-Look preflight passed; no HeyGen or Cosmos mutation occurred.' };
      }
      if (!loadEnv().ENABLE_HEYGEN_REFERENCE_LOOK_WRITES) {
        throw new Error('HeyGen reference-Look writes are disabled. Dry-run preflight remains available.');
      }
      const result = await executeHeyGenReferenceLookCreate(mapped, deps);
      return {
        data: result,
        audit: {
          after: {
            operation_id: result.operation_id,
            state: result.state,
            provider_look_id: result.provider_look_id,
            actual_credit_delta: result.actual_credit_delta,
          },
        },
        summary: `HeyGen reference-Look operation ${result.operation_id}: ${result.state}.`,
      };
    },
  }, callerHash);
}
