import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import {
  executeHeyGenAvatarVideoCreate,
  executeHeyGenRead,
  getHeyGenVideoDetail,
  getHeyGenVideoOperation,
  prepareHeyGenAvatarVideoCreate,
  HEYGEN_LOCALE_RE,
  HEYGEN_SAFE_ID_RE,
  type HeyGenAvatarVideoCreateResult,
  type HeyGenBrokerDeps,
} from './broker.js';
import {
  HEYGEN_IDEMPOTENCY_KEY_RE,
  HEYGEN_OPERATION_ID_RE,
  HEYGEN_SHA256_RE,
  type HeyGenAvatarVideoCreateInput,
} from './video-contracts.js';
import { ingestHeyGenVideoArtifacts } from './artifact-qa.js';
import { defaultHeyGenArtifactStore } from './artifact-store.js';
import { safeHeyGenAssetMetadata, safeHeyGenSessionResource } from './metadata.js';
import {
  HEYGEN_CREATION_TOOLS,
  HEYGEN_DATA_LANES,
  HEYGEN_DATA_TOOLS,
  HEYGEN_METADATA_TOOLS,
  HEYGEN_PAIRING_TOOLS,
  HEYGEN_PREFLIGHT_TOOLS,
  isHeyGenToolAllowed,
  type HeyGenToolName,
} from './access.js';
import { redactHeyGenAvatarVideoInputForLog } from './redaction.js';
import { isHeyGenProviderWriteEnabled } from './write-gate.js';
import {
  registerTool,
  type CallerHashProvider,
  type ToolResultPayload,
} from '../registry.js';

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const SAFE_ID = z.string().regex(HEYGEN_SAFE_ID_RE);
const SAFE_ID_ARRAY = z.array(SAFE_ID).min(1).max(100).optional();
const PAGINATION_TOKEN = z.string().max(4096).optional();
const BCP47_LOCALE = z.string().regex(HEYGEN_LOCALE_RE);
const LIST_100_INPUT = {
  limit: z.number().int().min(1).max(100).optional(),
  token: PAGINATION_TOKEN,
} as const;

export const HEYGEN_VIDEO_STATUSES_INPUT = {
  video_ids: SAFE_ID_ARRAY,
  batch_ids: SAFE_ID_ARRAY,
} as const;
export const HEYGEN_VIDEO_AGENT_SESSIONS_LIST_INPUT = LIST_100_INPUT;
export const HEYGEN_VIDEO_AGENT_SESSION_GET_INPUT = { session_id: SAFE_ID } as const;
export const HEYGEN_VIDEO_AGENT_SESSION_VIDEOS_LIST_INPUT = { session_id: SAFE_ID } as const;
export const HEYGEN_VIDEO_AGENT_RESOURCE_GET_INPUT = { session_id: SAFE_ID, resource_id: SAFE_ID } as const;
export const HEYGEN_ASSET_GET_INPUT = { asset_id: SAFE_ID } as const;
export const HEYGEN_ASSET_STATUSES_INPUT = {
  asset_ids: SAFE_ID_ARRAY,
  batch_ids: SAFE_ID_ARRAY,
} as const;
export const HEYGEN_BRAND_KITS_LIST_INPUT = LIST_100_INPUT;
export const HEYGEN_BRAND_GLOSSARIES_LIST_INPUT = LIST_100_INPUT;
export const HEYGEN_BRAND_GLOSSARY_GET_INPUT = { brand_glossary_id: SAFE_ID } as const;
export const HEYGEN_VOICE_GET_INPUT = { voice_id: SAFE_ID } as const;
export const HEYGEN_TRANSLATIONS_LIST_INPUT = LIST_100_INPUT;
export const HEYGEN_TRANSLATION_GET_INPUT = { video_translation_id: SAFE_ID } as const;
export const HEYGEN_TRANSLATION_STATUSES_INPUT = {
  video_translation_ids: SAFE_ID_ARRAY,
  batch_ids: SAFE_ID_ARRAY,
} as const;
export const HEYGEN_PROOFREAD_GET_INPUT = { proofread_id: SAFE_ID } as const;
export const HEYGEN_AVATAR_VIDEO_OPERATION_GET_INPUT = {
  operation_id: z.string().regex(HEYGEN_OPERATION_ID_RE),
} as const;

const VOICE_SETTINGS = z.object({
  speed: z.number().min(0.5).max(1.5).optional(),
  pitch: z.number().min(-50).max(50).optional(),
  volume: z.number().min(0).max(1).optional(),
  locale: BCP47_LOCALE.optional(),
}).strict();
const BACKGROUND = z.discriminatedUnion('type', [
  z.object({ type: z.literal('color'), value: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict(),
  z.object({ type: z.literal('image'), asset_id: SAFE_ID }).strict(),
]);
const CAPTION = z.object({
  file_format: z.literal('srt'),
  style: z.literal('default').optional(),
}).strict();

export const HEYGEN_AVATAR_VIDEO_CREATE_INPUT = {
  operation_id: z.string().regex(HEYGEN_OPERATION_ID_RE),
  idempotency_key: z.string().regex(HEYGEN_IDEMPOTENCY_KEY_RE),
  manifest_sha256: z.string().regex(HEYGEN_SHA256_RE),
  title: z.string().trim().min(1).max(200),
  avatar_id: SAFE_ID,
  voice_id: SAFE_ID,
  script: z.string().min(1).max(10_000).refine((value) => value.trim().length > 0, 'script cannot be blank'),
  engine: z.enum(['avatar_iii', 'avatar_iv', 'avatar_v']),
  reference_look_id: SAFE_ID.optional(),
  resolution: z.enum(['720p', '1080p']),
  aspect_ratio: z.enum(['16:9', '9:16', '4:5', '5:4', '1:1', 'auto']),
  fit: z.enum(['contain', 'cover']).optional(),
  motion_prompt: z.string().trim().min(1).max(500).optional(),
  expressiveness: z.enum(['low', 'medium', 'high']).optional(),
  background: BACKGROUND.optional(),
  caption: CAPTION.optional(),
  voice_settings: VOICE_SETTINGS.optional(),
  brand_glossary_id: SAFE_ID.optional(),
  confirm_credit_use: z.boolean().optional(),
  confirmed_premium_credits_before: z.number().int().min(0),
  confirmed_billing_snapshot_sha256: z.string().regex(HEYGEN_SHA256_RE).optional(),
  confirmed_billing_state_sha256: z.string().regex(HEYGEN_SHA256_RE).optional(),
  confirmed_billing_observed_at: z.string().datetime().optional(),
  owner_approval_jws: z.string().min(64).max(8192).optional(),
  max_approved_credits: z.number().int().min(1),
  reserve_premium_credits: z.number().int().min(0),
} as const;

export const HEYGEN_EXISTING_VIDEO_INGEST_QA_INPUT = {
  ingest_id: z.string().regex(HEYGEN_OPERATION_ID_RE),
  video_id: SAFE_ID,
  expected_title_sha256: z.string().regex(HEYGEN_SHA256_RE),
  include_captioned_video: z.boolean().optional(),
  include_subtitle: z.boolean().optional(),
  include_thumbnail: z.boolean().optional(),
  include_gif: z.boolean().optional(),
  max_asset_bytes: z.number().int().min(1_048_576).max(52_428_800).optional(),
} as const;

export const HEYGEN_VIDEO_WAIT_INGEST_QA_INPUT = {
  operation_id: z.string().regex(HEYGEN_OPERATION_ID_RE),
  video_id: SAFE_ID,
  max_wait_seconds: z.number().int().min(0).max(90).optional(),
  poll_interval_seconds: z.number().int().min(2).max(15).optional(),
  include_captioned_video: z.boolean().optional(),
  include_subtitle: z.boolean().optional(),
  include_thumbnail: z.boolean().optional(),
  include_gif: z.boolean().optional(),
  max_asset_bytes: z.number().int().min(1_048_576).max(52_428_800).optional(),
} as const;

const VIDEO_OPERATION_OUTPUT = {
  operation_id: z.string(),
  state: z.string(),
  provider_mutation: z.boolean().optional(),
  billing: z.unknown().optional(),
  preflight: z.unknown().optional(),
  approval_packet: z.unknown().optional(),
  replayed: z.boolean(),
  request_sha256: z.string(),
  video_id: z.string().optional(),
  provider_status: z.string().optional(),
  plan: z.string(),
  premium_credits_before: z.number().int().optional(),
  premium_credits_after: z.number().int().optional(),
  actual_credit_delta: z.number().int().optional(),
  billing_snapshot_before_sha256: z.string().optional(),
  billing_snapshot_after_sha256: z.string().optional(),
  max_approved_credits: z.number().int(),
  reserve_premium_credits: z.number().int(),
  estimated_credits: z.number().int(),
  estimated_duration_seconds: z.number().int(),
  provider_idempotency_expires_at: z.string().optional(),
  error_code: z.string().optional(),
} as const;

function laneRefusal(toolName: HeyGenToolName, caller: string | undefined | null): ToolResultPayload {
  const ctoOnly =
    (HEYGEN_PAIRING_TOOLS as readonly string[]).includes(toolName) ||
    (HEYGEN_CREATION_TOOLS as readonly string[]).includes(toolName);
  return {
    data: { error: 'forbidden_lane' },
    summary: ctoOnly
      ? `Refused: ${toolName} is CTO-only. Your identity: ${caller || '(none)'}.`
      : `Refused: ${toolName} is available only to internal lanes ${HEYGEN_DATA_LANES.join('/')}. Your identity: ${caller || '(none)'}.`,
  };
}

function avatarVideoInput(input: Record<string, unknown>, dryRun: boolean): HeyGenAvatarVideoCreateInput {
  const background = input.background as { type: 'color'; value: string } | { type: 'image'; asset_id: string } | undefined;
  const caption = input.caption as { file_format: 'srt'; style?: 'default' } | undefined;
  return {
    operationId: String(input.operation_id),
    idempotencyKey: String(input.idempotency_key),
    manifestSha256: String(input.manifest_sha256),
    title: String(input.title),
    avatarId: String(input.avatar_id),
    voiceId: String(input.voice_id),
    script: String(input.script),
    engine: input.engine as HeyGenAvatarVideoCreateInput['engine'],
    referenceLookId: typeof input.reference_look_id === 'string' ? input.reference_look_id : undefined,
    resolution: input.resolution as HeyGenAvatarVideoCreateInput['resolution'],
    aspectRatio: input.aspect_ratio as HeyGenAvatarVideoCreateInput['aspectRatio'],
    fit: input.fit as HeyGenAvatarVideoCreateInput['fit'],
    motionPrompt: typeof input.motion_prompt === 'string' ? input.motion_prompt : undefined,
    expressiveness: input.expressiveness as HeyGenAvatarVideoCreateInput['expressiveness'],
    background: background?.type === 'color'
      ? { type: 'color', value: background.value }
      : background?.type === 'image'
        ? { type: 'image', assetId: background.asset_id }
        : undefined,
    caption: caption ? { fileFormat: caption.file_format, style: caption.style } : undefined,
    voiceSettings: input.voice_settings as HeyGenAvatarVideoCreateInput['voiceSettings'],
    brandGlossaryId: typeof input.brand_glossary_id === 'string' ? input.brand_glossary_id : undefined,
    confirmCreditUse: dryRun || input.confirm_credit_use === true,
    confirmedPremiumCreditsBefore: Number(input.confirmed_premium_credits_before),
    confirmedBillingSnapshotSha256: typeof input.confirmed_billing_snapshot_sha256 === 'string'
      ? input.confirmed_billing_snapshot_sha256
      : undefined,
    confirmedBillingStateSha256: typeof input.confirmed_billing_state_sha256 === 'string'
      ? input.confirmed_billing_state_sha256
      : undefined,
    confirmedBillingObservedAt: typeof input.confirmed_billing_observed_at === 'string'
      ? input.confirmed_billing_observed_at
      : undefined,
    ownerApprovalJws: typeof input.owner_approval_jws === 'string' ? input.owner_approval_jws : undefined,
    maxApprovedCredits: Number(input.max_approved_credits),
    reservePremiumCredits: Number(input.reserve_premium_credits),
  };
}

function operationData(result: HeyGenAvatarVideoCreateResult): Record<string, unknown> {
  return {
    operation_id: result.operationId,
    state: result.state,
    replayed: result.replayed,
    request_sha256: result.requestSha256,
    video_id: result.videoId,
    provider_status: result.providerStatus,
    plan: result.plan,
    premium_credits_before: result.premiumCreditsBefore,
    premium_credits_after: result.premiumCreditsAfter,
    actual_credit_delta: result.actualCreditDelta,
    billing_snapshot_before_sha256: result.billingSnapshotBeforeSha256,
    billing_snapshot_after_sha256: result.billingSnapshotAfterSha256,
    max_approved_credits: result.maxApprovedCredits,
    reserve_premium_credits: result.reservePremiumCredits,
    estimated_credits: result.estimatedCredits,
    estimated_duration_seconds: result.estimatedDurationSeconds,
    provider_idempotency_expires_at: result.providerIdempotencyExpiresAt,
    error_code: result.errorCode,
  };
}

async function wait(milliseconds: number, deps: HeyGenBrokerDeps): Promise<void> {
  if (milliseconds <= 0) return;
  if (deps.sleep) return deps.sleep(milliseconds);
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function registerHeyGenProductionTools(
  server: McpServer,
  callerHash: CallerHashProvider,
  deps: HeyGenBrokerDeps,
): void {
  registerTool(server, {
    name: 'heygen_diagnostics_get',
    category: 'read',
    annotations: {
      title: 'HeyGen: safe production diagnostics',
      description: 'Returns the gateway build marker, exact fixed HeyGen action inventory, OAuth-only transport posture, artifact-store readiness, mutation switches, and owner-verifier readiness. No provider call, credential, token, or signed URL is returned.',
      ...READ_ANNOTATIONS,
      openWorldHint: false,
    },
    inputShape: {},
    outputShape: { diagnostics: z.unknown(), error: z.string().optional() },
    handler: async (_input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_diagnostics_get', ctx.callerAgent)) return laneRefusal('heygen_diagnostics_get', ctx.callerAgent);
      const env = loadEnv();
      const tools = [
        ...HEYGEN_PAIRING_TOOLS,
        ...HEYGEN_DATA_TOOLS,
        ...HEYGEN_METADATA_TOOLS,
        ...HEYGEN_PREFLIGHT_TOOLS,
        ...HEYGEN_CREATION_TOOLS,
      ];
      return {
        data: {
          diagnostics: {
            build: process.env.DD_VERSION || process.env.GITHUB_SHA || 'unknown',
            provider_base: 'https://api.heygen.com',
            credential_transport: 'oauth_bearer_only',
            api_key_path_present: false,
            subscription_guard: true,
            action_count: tools.length,
            actions: tools,
            artifact_store_configured: defaultHeyGenArtifactStore.configured(),
            feature_flags: {
              provider_writes: env.ENABLE_HEYGEN_PROVIDER_WRITES,
              prompt_avatar_writes: env.ENABLE_HEYGEN_PROMPT_AVATAR_WRITES,
              avatar_video_writes: env.ENABLE_HEYGEN_AVATAR_VIDEO_WRITES,
              reference_look_writes: env.ENABLE_HEYGEN_REFERENCE_LOOK_WRITES,
              video_agent_chat_writes: env.ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES,
              video_agent_generation: env.ENABLE_HEYGEN_VIDEO_AGENT_GENERATION,
              asset_writes: env.ENABLE_HEYGEN_ASSET_WRITES,
              translation_writes: env.ENABLE_HEYGEN_TRANSLATION_WRITES,
              tts_writes: env.ENABLE_HEYGEN_TTS_WRITES,
              metadata_writes: env.ENABLE_HEYGEN_METADATA_WRITES,
            },
            owner_approval_verifier_configured: Boolean(
              env.HEYGEN_OWNER_APPROVAL_SUBJECT && env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK,
            ),
          },
        },
        summary: `HeyGen diagnostics: ${tools.length} fixed actions, OAuth Bearer only, credit-consuming provider writes ${env.ENABLE_HEYGEN_PROVIDER_WRITES ? 'armed' : 'dark'}.`,
      };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_video_statuses_get',
    category: 'read',
    annotations: { title: 'HeyGen: bulk video statuses', description: 'Read-only GET /v3/videos/statuses for up to 100 video or batch ids.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_VIDEO_STATUSES_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_video_statuses_get', ctx.callerAgent)) return laneRefusal('heygen_video_statuses_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'videoStatuses', videoIds: input.video_ids, batchIds: input.batch_ids }, deps);
      return { data: { body }, summary: 'HeyGen video statuses retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_video_agent_sessions_list',
    category: 'read',
    annotations: { title: 'HeyGen: list Video Agent sessions', description: 'Read-only GET /v3/video-agents.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_VIDEO_AGENT_SESSIONS_LIST_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_video_agent_sessions_list', ctx.callerAgent)) return laneRefusal('heygen_video_agent_sessions_list', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'videoAgentSessions', limit: input.limit, token: input.token }, deps);
      return { data: { body }, summary: 'HeyGen Video Agent sessions retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_video_agent_session_get',
    category: 'read',
    annotations: { title: 'HeyGen: get Video Agent session', description: 'Read-only GET /v3/video-agents/{session_id}.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_VIDEO_AGENT_SESSION_GET_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_video_agent_session_get', ctx.callerAgent)) return laneRefusal('heygen_video_agent_session_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'videoAgentSession', sessionId: input.session_id }, deps);
      return { data: { body }, summary: `HeyGen Video Agent session ${input.session_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_video_agent_session_videos_list',
    category: 'read',
    annotations: { title: 'HeyGen: list session videos', description: 'Read-only GET /v3/video-agents/{session_id}/videos.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_VIDEO_AGENT_SESSION_VIDEOS_LIST_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_video_agent_session_videos_list', ctx.callerAgent)) return laneRefusal('heygen_video_agent_session_videos_list', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'videoAgentSessionVideos', sessionId: input.session_id }, deps);
      return { data: { body }, summary: `HeyGen videos for session ${input.session_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_video_agent_resource_get',
    category: 'read',
    annotations: {
      title: 'HeyGen: get safe Video Agent resource metadata',
      description: 'Reads one Video Agent session resource and returns only bounded metadata plus URL fingerprints. Provider URLs and open-ended instructions never leave the gateway.',
      ...READ_ANNOTATIONS,
    },
    inputShape: HEYGEN_VIDEO_AGENT_RESOURCE_GET_INPUT,
    outputShape: { resource: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_video_agent_resource_get', ctx.callerAgent)) return laneRefusal('heygen_video_agent_resource_get', ctx.callerAgent);
      const raw = await executeHeyGenRead({
        kind: 'videoAgentResource',
        sessionId: input.session_id,
        resourceId: input.resource_id,
      }, deps);
      const resource = safeHeyGenSessionResource(raw);
      return { data: { resource }, summary: `Safe HeyGen resource metadata ${input.resource_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_asset_get',
    category: 'read',
    annotations: {
      title: 'HeyGen: get safe asset metadata',
      description: 'Reads GET /v3/assets/{asset_id} and removes the owner and provider URL, returning a URL-presence flag and SHA-256 fingerprint instead.',
      ...READ_ANNOTATIONS,
    },
    inputShape: HEYGEN_ASSET_GET_INPUT,
    outputShape: { asset: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_asset_get', ctx.callerAgent)) return laneRefusal('heygen_asset_get', ctx.callerAgent);
      const raw = await executeHeyGenRead({ kind: 'asset', assetId: input.asset_id }, deps);
      const asset = safeHeyGenAssetMetadata(raw);
      return { data: { asset }, summary: `Safe HeyGen asset metadata ${input.asset_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_asset_statuses_get',
    category: 'read',
    annotations: {
      title: 'HeyGen: bulk asset statuses',
      description: 'Read-only GET /v3/assets/statuses for up to 100 asset or batch ids.',
      ...READ_ANNOTATIONS,
    },
    inputShape: HEYGEN_ASSET_STATUSES_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_asset_statuses_get', ctx.callerAgent)) return laneRefusal('heygen_asset_statuses_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'assetStatuses', assetIds: input.asset_ids, batchIds: input.batch_ids }, deps);
      return { data: { body }, summary: 'HeyGen asset statuses retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_brand_kits_list',
    category: 'read',
    annotations: { title: 'HeyGen: list brand kits', description: 'Read-only GET /v3/brand-kits.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_BRAND_KITS_LIST_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_brand_kits_list', ctx.callerAgent)) return laneRefusal('heygen_brand_kits_list', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'brandKits', limit: input.limit, token: input.token }, deps);
      return { data: { body }, summary: 'HeyGen brand kits retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_brand_glossaries_list',
    category: 'read',
    annotations: { title: 'HeyGen: list brand glossaries', description: 'Read-only GET /v3/brand-glossaries.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_BRAND_GLOSSARIES_LIST_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_brand_glossaries_list', ctx.callerAgent)) return laneRefusal('heygen_brand_glossaries_list', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'brandGlossaries', limit: input.limit, token: input.token }, deps);
      return { data: { body }, summary: 'HeyGen brand glossaries retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_brand_glossary_get',
    category: 'read',
    annotations: { title: 'HeyGen: get brand glossary', description: 'Read-only GET /v3/brand-glossaries/{brand_glossary_id}.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_BRAND_GLOSSARY_GET_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_brand_glossary_get', ctx.callerAgent)) return laneRefusal('heygen_brand_glossary_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'brandGlossary', brandGlossaryId: input.brand_glossary_id }, deps);
      return { data: { body }, summary: `HeyGen brand glossary ${input.brand_glossary_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_voice_get',
    category: 'read',
    annotations: { title: 'HeyGen: get voice', description: 'Read-only GET /v3/voices/{voice_id}.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_VOICE_GET_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_voice_get', ctx.callerAgent)) return laneRefusal('heygen_voice_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'voice', voiceId: input.voice_id }, deps);
      return { data: { body }, summary: `HeyGen voice ${input.voice_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_translation_languages_list',
    category: 'read',
    annotations: { title: 'HeyGen: list translation languages', description: 'Read-only GET /v3/video-translations/languages.', ...READ_ANNOTATIONS },
    inputShape: {},
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (_input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_translation_languages_list', ctx.callerAgent)) return laneRefusal('heygen_translation_languages_list', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'translationLanguages' }, deps);
      return { data: { body }, summary: 'HeyGen translation languages retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_translations_list',
    category: 'read',
    annotations: { title: 'HeyGen: list translations', description: 'Read-only GET /v3/video-translations.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_TRANSLATIONS_LIST_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_translations_list', ctx.callerAgent)) return laneRefusal('heygen_translations_list', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'translations', limit: input.limit, token: input.token }, deps);
      return { data: { body }, summary: 'HeyGen translations retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_translation_get',
    category: 'read',
    annotations: { title: 'HeyGen: get translation', description: 'Read-only GET /v3/video-translations/{video_translation_id}.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_TRANSLATION_GET_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_translation_get', ctx.callerAgent)) return laneRefusal('heygen_translation_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'translation', translationId: input.video_translation_id }, deps);
      return { data: { body }, summary: `HeyGen translation ${input.video_translation_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_translation_statuses_get',
    category: 'read',
    annotations: { title: 'HeyGen: bulk translation statuses', description: 'Read-only GET /v3/video-translations/statuses.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_TRANSLATION_STATUSES_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_translation_statuses_get', ctx.callerAgent)) return laneRefusal('heygen_translation_statuses_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'translationStatuses', translationIds: input.video_translation_ids, batchIds: input.batch_ids }, deps);
      return { data: { body }, summary: 'HeyGen translation statuses retrieved.' };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_proofread_get',
    category: 'read',
    annotations: { title: 'HeyGen: get proofread', description: 'Read-only GET /v3/video-translations/proofreads/{proofread_id}.', ...READ_ANNOTATIONS },
    inputShape: HEYGEN_PROOFREAD_GET_INPUT,
    outputShape: { body: z.unknown(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_proofread_get', ctx.callerAgent)) return laneRefusal('heygen_proofread_get', ctx.callerAgent);
      const body = await executeHeyGenRead({ kind: 'proofread', proofreadId: input.proofread_id }, deps);
      return { data: { body }, summary: `HeyGen proofread ${input.proofread_id} retrieved.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_avatar_video_operation_get',
    category: 'read',
    annotations: { title: 'HeyGen: get durable video operation', description: 'Reads the gateway-owned idempotency and credit-operation record. No script, token, signed URL, or raw key is returned.', ...READ_ANNOTATIONS, openWorldHint: false },
    inputShape: HEYGEN_AVATAR_VIDEO_OPERATION_GET_INPUT,
    outputShape: { found: z.boolean(), operation: z.object(VIDEO_OPERATION_OUTPUT).strict().nullable() },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_avatar_video_operation_get', ctx.callerAgent)) return laneRefusal('heygen_avatar_video_operation_get', ctx.callerAgent);
      const operation = await getHeyGenVideoOperation(input.operation_id, deps);
      return { data: { found: operation !== null, operation: operation ? operationData(operation) : null }, summary: operation ? `HeyGen video operation ${input.operation_id}: ${operation.state}.` : `HeyGen video operation ${input.operation_id} not found.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_avatar_video_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'HeyGen: create idempotent Avatar Video (CTO only)',
      description: 'Creates exactly one direct Avatar Video through POST /v3/videos with a mandatory 24-hour provider Idempotency-Key, durable cross-replica operation record, exact live subscription balance, explicit credit ceiling/reserve, look/group/voice/engine validation, and no API-key billing path.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: HEYGEN_AVATAR_VIDEO_CREATE_INPUT,
    outputShape: VIDEO_OPERATION_OUTPUT,
    redactInputForLog: redactHeyGenAvatarVideoInputForLog,
    shieldInputForScan: (input) => ({ title: input.title, script: input.script, motion_prompt: input.motion_prompt }),
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_avatar_video_create', ctx.callerAgent)) return laneRefusal('heygen_avatar_video_create', ctx.callerAgent);
      const mapped = avatarVideoInput(input as unknown as Record<string, unknown>, ctx.dryRun);
      if (ctx.dryRun) {
        const prepared = await prepareHeyGenAvatarVideoCreate(mapped, deps);
        const premiumBefore = prepared.billing.premium.remaining ?? 0;
        if (premiumBefore - mapped.maxApprovedCredits < mapped.reservePremiumCredits) {
          throw new Error('The approved Avatar Video ceiling would cross the live reserve floor.');
        }
        const dry: HeyGenAvatarVideoCreateResult = {
          operationId: mapped.operationId,
          state: 'dry_run',
          replayed: false,
          requestSha256: prepared.plan.requestSha256,
          plan: prepared.billing.plan,
          premiumCreditsBefore: prepared.billing.premium.remaining ?? undefined,
          billingSnapshotBeforeSha256: prepared.billing.snapshot_sha256,
          maxApprovedCredits: mapped.maxApprovedCredits,
          reservePremiumCredits: mapped.reservePremiumCredits,
          estimatedCredits: prepared.plan.estimatedCredits,
          estimatedDurationSeconds: prepared.plan.estimatedDurationSeconds,
        };
        return {
          data: {
            ...operationData(dry),
            provider_mutation: false,
            billing: prepared.billing,
            preflight: {
              avatar_id: prepared.look.id,
              avatar_type: prepared.look.avatarType,
              group_id: prepared.group.id,
              group_status: prepared.group.status,
              consent_status: prepared.group.consentStatus,
              voice_id: prepared.voice.voiceId,
              voice_status: prepared.voice.status,
              engine: mapped.engine,
              reference_look_id: prepared.referenceLook?.id,
            },
            approval_packet: {
              grant_type: 'heygen_avatar_video_create',
              tool: 'heygen_avatar_video_create',
              operation_id: mapped.operationId,
              request_sha256: prepared.plan.requestSha256,
              billing_snapshot_sha256: prepared.billing.snapshot_sha256,
              billing_state_sha256: prepared.billing.state_sha256,
              billing_observed_at: prepared.billing.observed_at,
              confirmed_premium_credits_before: prepared.billing.premium.remaining,
              reserve_credits: mapped.reservePremiumCredits,
              max_credits: mapped.maxApprovedCredits,
              owner_grant_required: true,
              zero_automatic_retries: true,
            },
          },
          summary: `DRY RUN: live Avatar Video preflight passed; estimated ${prepared.plan.estimatedCredits} credit(s), no provider or operation-record mutation.`,
        };
      }
      const existing = await getHeyGenVideoOperation(mapped.operationId, deps);
      if (existing && (existing.state === 'accepted' || existing.state === 'rejected')) {
        return {
          data: operationData(existing),
          summary: `HeyGen Avatar Video operation ${existing.operationId}: ${existing.state} (terminal replay; writes remain disabled).`,
        };
      }
      if (!isHeyGenProviderWriteEnabled('ENABLE_HEYGEN_AVATAR_VIDEO_WRITES')) {
        throw new Error('HeyGen Avatar Video writes are disabled. Dry-run preflight and terminal operation replay remain available.');
      }
      const result = await executeHeyGenAvatarVideoCreate(mapped, deps);
      return {
        data: operationData(result),
        audit: { after: { operation_id: result.operationId, state: result.state, video_id: result.videoId } },
        summary: `HeyGen Avatar Video operation ${result.operationId}: ${result.state}${result.videoId ? `, video ${result.videoId}` : ''}.`,
      };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_existing_video_ingest_qa',
    category: 'write_orchestrated',
    annotations: {
      title: 'HeyGen: securely ingest an existing completed account video (CTO only)',
      description: 'Reads one owner-designated existing account video, verifies its title hash and completed state, downloads only allowlisted HeyGen assets without exposing signed URLs, validates/hashes them, and stores a private Azure artifact manifest. It never creates or alters provider media.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: HEYGEN_EXISTING_VIDEO_INGEST_QA_INPUT,
    outputShape: {
      status: z.string(),
      ingested: z.boolean(),
      video_id: z.string(),
      manifest_uri: z.string().optional(),
      duration_seconds: z.number().optional(),
      assets: z.array(z.object({
        kind: z.string(),
        artifact_uri: z.string(),
        sha256: z.string(),
        size_bytes: z.number().int(),
        content_type: z.string(),
        extension: z.string(),
        magic_valid: z.boolean(),
        srt_cue_count: z.number().int().optional(),
      }).strict()).optional(),
      qa: z.object({
        technical_pass: z.boolean(),
        manual_visual_review_required: z.boolean(),
        checks: z.array(z.string()),
      }).strict().optional(),
    },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_existing_video_ingest_qa', ctx.callerAgent)) return laneRefusal('heygen_existing_video_ingest_qa', ctx.callerAgent);
      if (ctx.dryRun) {
        return {
          data: { status: 'dry_run', ingested: false, video_id: input.video_id },
          summary: 'DRY RUN: no download, provider mutation, QA, or Blob write occurred.',
        };
      }
      const detail = await getHeyGenVideoDetail(input.video_id, deps);
      const titleSha256 = createHash('sha256').update(detail.title ?? '', 'utf8').digest('hex');
      if (titleSha256 !== input.expected_title_sha256) {
        throw new Error('Existing HeyGen video title hash does not match the owner-designated artifact.');
      }
      if (detail.status !== 'completed') {
        return {
          data: { status: detail.status, ingested: false, video_id: detail.id },
          summary: `HeyGen video ${detail.id} is ${detail.status}; no artifact was ingested.`,
        };
      }
      const ingested = await ingestHeyGenVideoArtifacts(detail, {
        operationId: input.ingest_id,
        includeCaptionedVideo: input.include_captioned_video ?? false,
        includeSubtitle: input.include_subtitle ?? true,
        includeThumbnail: input.include_thumbnail ?? true,
        includeGif: input.include_gif ?? false,
        maxAssetBytes: input.max_asset_bytes ?? 52_428_800,
      });
      return {
        data: {
          status: 'completed',
          ingested: true,
          video_id: ingested.videoId,
          manifest_uri: ingested.manifestUri,
          duration_seconds: ingested.duration,
          assets: ingested.assets.map((asset) => ({
            kind: asset.kind,
            artifact_uri: asset.artifactUri,
            sha256: asset.sha256,
            size_bytes: asset.sizeBytes,
            content_type: asset.contentType,
            extension: asset.extension,
            magic_valid: asset.magicValid,
            srt_cue_count: asset.srtCueCount,
          })),
          qa: {
            technical_pass: ingested.qa.technicalPass,
            manual_visual_review_required: ingested.qa.manualVisualReviewRequired,
            checks: ingested.qa.checks,
          },
        },
        audit: {
          after: {
            ingest_id: input.ingest_id,
            video_id: ingested.videoId,
            manifest_uri: ingested.manifestUri,
            asset_count: ingested.assets.length,
          },
        },
        summary: `Existing HeyGen video ${ingested.videoId} securely ingested with ${ingested.assets.length} artifact(s); visual/likeness approval remains manual.`,
      };
    },
  }, callerHash);

  registerTool(server, {
    name: 'heygen_video_wait_ingest_qa',
    category: 'write_orchestrated',
    annotations: {
      title: 'HeyGen: wait, ingest, and technically QA video (CTO only)',
      description: 'Polls a video tied to a durable operation for up to 90 seconds; on completion downloads only allowlisted HeyGen signed assets without logging their URLs, validates size/content magic/SRT cues, hashes them, writes private non-PHI artifacts plus a manifest to Azure Blob, and leaves visual/likeness approval explicitly manual.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: HEYGEN_VIDEO_WAIT_INGEST_QA_INPUT,
    outputShape: {
      status: z.string(),
      ingested: z.boolean(),
      video_id: z.string(),
      failure_code: z.string().optional(),
      manifest_uri: z.string().optional(),
      duration_seconds: z.number().optional(),
      assets: z.array(z.object({
        kind: z.string(),
        artifact_uri: z.string(),
        sha256: z.string(),
        size_bytes: z.number().int(),
        content_type: z.string(),
        extension: z.string(),
        magic_valid: z.boolean(),
        srt_cue_count: z.number().int().optional(),
      }).strict()).optional(),
      qa: z.object({
        technical_pass: z.boolean(),
        manual_visual_review_required: z.boolean(),
        checks: z.array(z.string()),
      }).strict().optional(),
    },
    handler: async (input, ctx) => {
      if (!isHeyGenToolAllowed('heygen_video_wait_ingest_qa', ctx.callerAgent)) return laneRefusal('heygen_video_wait_ingest_qa', ctx.callerAgent);
      if (ctx.dryRun) {
        return {
          data: { status: 'dry_run', ingested: false, video_id: input.video_id },
          summary: 'DRY RUN: no polling, download, QA, or Blob write occurred.',
        };
      }
      const operation = await getHeyGenVideoOperation(input.operation_id, deps);
      if (!operation || operation.videoId !== input.video_id) {
        throw new Error('video_id is not bound to this durable HeyGen operation.');
      }
      const deadline = deps.now() + (input.max_wait_seconds ?? 0) * 1000;
      let detail = await getHeyGenVideoDetail(input.video_id, deps);
      while ((detail.status === 'pending' || detail.status === 'processing') && deps.now() < deadline) {
        await wait((input.poll_interval_seconds ?? 5) * 1000, deps);
        detail = await getHeyGenVideoDetail(input.video_id, deps);
      }
      if (detail.status === 'failed') {
        return {
          data: { status: 'failed', ingested: false, video_id: detail.id, failure_code: detail.failureCode ?? 'unknown' },
          summary: `HeyGen video ${detail.id} failed; no artifact was ingested.`,
        };
      }
      if (detail.status !== 'completed') {
        return {
          data: { status: detail.status, ingested: false, video_id: detail.id },
          summary: `HeyGen video ${detail.id} is ${detail.status}; call again later.`,
        };
      }
      const ingested = await ingestHeyGenVideoArtifacts(detail, {
        operationId: input.operation_id,
        includeCaptionedVideo: input.include_captioned_video ?? false,
        includeSubtitle: input.include_subtitle ?? true,
        includeThumbnail: input.include_thumbnail ?? true,
        includeGif: input.include_gif ?? false,
        maxAssetBytes: input.max_asset_bytes ?? 52_428_800,
      });
      return {
        data: {
          status: 'completed',
          ingested: true,
          video_id: ingested.videoId,
          manifest_uri: ingested.manifestUri,
          duration_seconds: ingested.duration,
          assets: ingested.assets.map((asset) => ({
            kind: asset.kind,
            artifact_uri: asset.artifactUri,
            sha256: asset.sha256,
            size_bytes: asset.sizeBytes,
            content_type: asset.contentType,
            extension: asset.extension,
            magic_valid: asset.magicValid,
            srt_cue_count: asset.srtCueCount,
          })),
          qa: {
            technical_pass: ingested.qa.technicalPass,
            manual_visual_review_required: ingested.qa.manualVisualReviewRequired,
            checks: ingested.qa.checks,
          },
        },
        audit: { after: { operation_id: input.operation_id, video_id: ingested.videoId, manifest_uri: ingested.manifestUri } },
        summary: `HeyGen video ${ingested.videoId} ingested and passed technical QA. Manual visual and likeness review remains required.`,
      };
    },
  }, callerHash);
}
