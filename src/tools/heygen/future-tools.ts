import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { loadEnv, type Env } from '../../config/env.js';
import { registerTool, type CallerHashProvider, type ToolResultPayload } from '../registry.js';
import { HEYGEN_DATA_LANES } from './access.js';
import {
  executeHeyGenRead,
  getHeyGenAccessToken,
  heyGenApiGet,
  heyGenApiPatch,
  HEYGEN_SAFE_ID_RE,
  type HeyGenBrokerDeps,
} from './broker.js';
import { parseHeyGenBillingSnapshot } from './look-contracts.js';
import { canonicalJsonSha256 } from './video-contracts.js';

const SAFE_ID = z.string().regex(HEYGEN_SAFE_ID_RE);
const ACTION_ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const IDEMPOTENCY = z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/);
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const OWNER_JWS = z.string().min(64).max(8192);
const ASSET_IDS = z.array(SAFE_ID).max(20);

export const HEYGEN_VIDEO_AGENT_SESSION_CREATE_INPUT = {
  project_id: ACTION_ID,
  action_id: ACTION_ID,
  manifest_sha256: SHA256,
  planning_prompt: z.string().min(1).max(9000),
  avatar_id: SAFE_ID,
  voice_id: SAFE_ID,
  brand_kit_id: SAFE_ID,
  orientation: z.enum(['landscape', 'portrait']),
  asset_ids: ASSET_IDS.optional(),
  style_id: SAFE_ID.optional(),
  billing_snapshot_sha256: SHA256,
  reserve_total_credits: z.number().int().min(0),
} as const;

export const HEYGEN_VIDEO_AGENT_FEEDBACK_SEND_INPUT = {
  session_id: SAFE_ID,
  project_id: ACTION_ID,
  action_id: ACTION_ID,
  expected_session_snapshot_sha256: SHA256,
  intent: z.enum(['answer_question', 'revise_plan']),
  message: z.string().min(1).max(9000),
} as const;

export const HEYGEN_VIDEO_AGENT_GENERATION_APPROVE_INPUT = {
  session_id: SAFE_ID,
  project_id: ACTION_ID,
  action_id: ACTION_ID,
  manifest_sha256: SHA256,
  review_snapshot_sha256: SHA256,
  billing_snapshot_sha256: SHA256,
  max_approved_credits: z.number().int().min(1),
  reserve_total_credits: z.number().int().min(0),
  confirm_credit_use: z.literal(true),
  accept_unenforced_cost_cap: z.literal(true),
  owner_approval_jws: OWNER_JWS,
} as const;

export const HEYGEN_VIDEO_AGENT_SESSION_STOP_INPUT = {
  session_id: SAFE_ID,
  project_id: ACTION_ID,
  action_id: ACTION_ID,
  expected_session_snapshot_sha256: SHA256,
  reason: z.enum(['unexpected_generation', 'budget_drift', 'operator_cancel', 'session_stuck']),
} as const;

export const HEYGEN_ASSET_UPLOAD_INPUT = {
  operation_id: ACTION_ID,
  idempotency_key: IDEMPOTENCY,
  source_artifact_uri: z.string().regex(/^azure:\/\/[A-Za-z0-9_.\-/]{3,512}$/),
  filename: z.string().regex(/^[A-Za-z0-9_. -]{1,128}$/),
  content_type: z.enum(['image/png', 'image/jpeg', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'application/pdf', 'application/x-subrip']),
  size_bytes: z.number().int().min(1).max(33_554_432),
  checksum_sha256: SHA256,
} as const;

export const HEYGEN_TRANSLATION_CREATE_INPUT = {
  operation_id: ACTION_ID,
  idempotency_key: IDEMPOTENCY,
  source_asset_id: SAFE_ID,
  locked_master_sha256: SHA256,
  title: z.string().trim().min(1).max(200),
  output_languages: z.array(z.string().trim().min(1).max(128)).min(1).max(10),
  input_language: z.string().trim().min(1).max(32).optional(),
  speaker_num: z.number().int().min(1).max(20).optional(),
  mode: z.enum(['speed', 'precision']),
  translate_audio_only: z.boolean().optional(),
  keep_the_same_format: z.boolean().optional(),
  billing_snapshot_sha256: SHA256,
  max_approved_credits: z.number().int().min(1),
  reserve_total_credits: z.number().int().min(0),
  owner_approval_jws: OWNER_JWS,
} as const;

export const HEYGEN_PROOFREAD_CREATE_INPUT = {
  operation_id: ACTION_ID,
  idempotency_key: IDEMPOTENCY,
  source_asset_id: SAFE_ID,
  locked_master_sha256: SHA256,
  title: z.string().trim().min(1).max(200),
  output_languages: z.array(z.string().trim().min(1).max(128)).min(1).max(10),
  brand_glossary_id: SAFE_ID.optional(),
  speaker_num: z.number().int().min(1).max(20).optional(),
  mode: z.enum(['speed', 'precision']),
} as const;

export const HEYGEN_PROOFREAD_GENERATE_INPUT = {
  operation_id: ACTION_ID,
  idempotency_key: IDEMPOTENCY,
  proofread_id: SAFE_ID,
  approved_proofread_sha256: SHA256,
  billing_snapshot_sha256: SHA256,
  max_approved_credits: z.number().int().min(1),
  reserve_total_credits: z.number().int().min(0),
  owner_approval_jws: OWNER_JWS,
} as const;

export const HEYGEN_SPEECH_PREVIEW_CREATE_INPUT = {
  operation_id: ACTION_ID,
  voice_id: SAFE_ID,
  text: z.string().min(1).max(5000),
  input_type: z.enum(['text', 'ssml']).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
  locale: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/).optional(),
  billing_snapshot_sha256: SHA256,
  max_approved_credits: z.number().int().min(1),
  owner_approval_jws: OWNER_JWS,
} as const;

export const HEYGEN_AVATAR_LOOK_NAME_UPDATE_INPUT = {
  look_id: SAFE_ID,
  name: z.string().trim().min(1).max(255),
} as const;

const LookNameEnvelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    avatar_type: z.enum(['photo_avatar', 'digital_twin', 'studio_avatar']),
    group_id: z.string().min(1).nullable().optional(),
    status: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough();

function safeLookName(value: unknown): Record<string, unknown> {
  const data = LookNameEnvelopeSchema.parse(value).data;
  return {
    look_id: data.id,
    name: data.name.slice(0, 255),
    avatar_type: data.avatar_type,
    group_id: data.group_id ?? null,
    status: data.status ?? null,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function redact(input: Record<string, unknown>): unknown {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (['planning_prompt', 'message', 'text', 'owner_approval_jws', 'name', 'title', 'filename'].includes(key)) {
      output[`${key}_sha256`] = hash(String(value ?? ''));
      continue;
    }
    if (key.endsWith('_ids') && Array.isArray(value)) {
      output[`${key}_count`] = value.length;
      continue;
    }
    output[key] = value;
  }
  return output;
}

function shieldProjection(input: Record<string, unknown>): unknown {
  const projected: Record<string, unknown> = {};
  for (const key of ['planning_prompt', 'message', 'text', 'name', 'title', 'filename']) {
    if (typeof input[key] === 'string') projected[key] = input[key];
  }
  return projected;
}

function refusal(toolName: string, caller: string, dryRun: boolean): ToolResultPayload {
  return {
    data: { error: 'forbidden_lane' },
    summary: dryRun
      ? `Refused: ${toolName} dry-run is limited to internal HeyGen lanes. Your identity: ${caller || '(none)'}.`
      : `Refused: live ${toolName} is CTO-only. Your identity: ${caller || '(none)'}.`,
  };
}

function dryPlan(tool: string, endpoint: string, body: Record<string, unknown>, flag: keyof Env): ToolResultPayload {
  return {
    data: {
      mode: 'preflight',
      tool,
      endpoint,
      provider_mutation: false,
      operation_record_mutation: false,
      request_sha256: canonicalJsonSha256(body),
      feature_enabled: Boolean(loadEnv()[flag]),
      implemented: false,
      notice: 'Preflight contract validated. The provider-write action is not implemented or enabled; no provider or operation-record mutation occurred.',
    },
    summary: `PREFLIGHT: ${tool} contract validated; provider execution is not implemented and no mutation occurred.`,
  };
}

function registerDarkTool(
  server: McpServer,
  callerHash: CallerHashProvider,
  definition: {
    name: string;
    description: string;
    inputShape: ZodRawShape;
    endpoint: string;
    flag: keyof Env;
    body: (input: Record<string, unknown>) => Record<string, unknown>;
  },
): void {
  registerTool(server, {
    name: definition.name,
    category: 'read',
    annotations: {
      title: `HeyGen: ${definition.name.replace(/^heygen_/, '').replaceAll('_', ' ')}`,
      description: `Preflight-only contract; no provider execution is implemented. ${definition.description}`,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: definition.inputShape,
    outputShape: {
      mode: z.string(),
      tool: z.string(),
      endpoint: z.string(),
      provider_mutation: z.boolean(),
      operation_record_mutation: z.boolean(),
      request_sha256: z.string(),
      feature_enabled: z.boolean(),
      implemented: z.boolean(),
      notice: z.string(),
      error: z.string().optional(),
    },
    redactInputForLog: redact,
    shieldInputForScan: shieldProjection,
    handler: async (input, ctx) => {
      if (!(HEYGEN_DATA_LANES as readonly string[]).includes(ctx.callerAgent)) {
        return refusal(definition.name, ctx.callerAgent, true);
      }
      const body = definition.body(input as unknown as Record<string, unknown>);
      return dryPlan(definition.name, definition.endpoint, body, definition.flag);
    },
  }, callerHash);
}

export function registerHeyGenFutureTools(
  server: McpServer,
  callerHash: CallerHashProvider,
  deps: HeyGenBrokerDeps,
): void {
  registerDarkTool(server, callerHash, {
    name: 'heygen_video_agent_session_create_preflight',
    description: 'Creates only a chat-mode, incognito Video Agent planning session. The provider body forces mode=chat and planning-only instructions; generation has a separate approval action.',
    inputShape: HEYGEN_VIDEO_AGENT_SESSION_CREATE_INPUT,
    endpoint: 'POST /v3/video-agents',
    flag: 'ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES',
    body: (input) => ({
      mode: 'chat',
      incognito_mode: true,
      prompt: `${String(input.planning_prompt)}\n\nPlanning only. Do not generate media. Return to a review checkpoint.`,
      avatar_id: input.avatar_id,
      voice_id: input.voice_id,
      brand_kit_id: input.brand_kit_id,
      style_id: input.style_id,
      orientation: input.orientation,
      files: (input.asset_ids as string[] | undefined)?.map((assetId) => ({ type: 'asset_id', asset_id: assetId })),
    }),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_video_agent_feedback_send_preflight',
    description: 'Sends planning feedback only. Confirmation, approval, proceed, or spend intent is not represented by this schema and cannot trigger generation.',
    inputShape: HEYGEN_VIDEO_AGENT_FEEDBACK_SEND_INPUT,
    endpoint: 'POST /v3/video-agents/{session_id}',
    flag: 'ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES',
    body: (input) => ({
      message: `${String(input.message)}\n\nRevise the plan only and return to review. Do not generate media.`,
    }),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_video_agent_generation_approve_preflight',
    description: 'Separate fixed generation approval action. It accepts no arbitrary confirmation text and remains disabled until the owner-grant, account spend fence, and hash-pinned complete plan are live.',
    inputShape: HEYGEN_VIDEO_AGENT_GENERATION_APPROVE_INPUT,
    endpoint: 'POST /v3/video-agents/{session_id}',
    flag: 'ENABLE_HEYGEN_VIDEO_AGENT_GENERATION',
    body: () => ({ message: 'Generate exactly the reviewed hash-pinned plan without substitutions or model escalation.' }),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_video_agent_session_stop_preflight',
    description: 'Stops only a locally owned Video Agent session through an exact empty provider body. Ambiguous stop results are never automatically replayed.',
    inputShape: HEYGEN_VIDEO_AGENT_SESSION_STOP_INPUT,
    endpoint: 'POST /v3/video-agents/{session_id}/stop',
    flag: 'ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES',
    body: () => ({}),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_asset_upload_preflight',
    description: 'Uploads one hash-pinned file from approved private Azure storage. The fixed contract forbids public URLs, raw bytes/base64, redirects, unsupported MIME types, and files over 32 MiB.',
    inputShape: HEYGEN_ASSET_UPLOAD_INPUT,
    endpoint: 'internal Azure artifact resolver -> multipart POST /v3/assets',
    flag: 'ENABLE_HEYGEN_ASSET_WRITES',
    body: (input) => ({
      source_artifact_uri: input.source_artifact_uri,
      filename: input.filename,
      content_type: input.content_type,
      size_bytes: input.size_bytes,
      checksum_sha256: input.checksum_sha256,
    }),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_translation_create_preflight',
    description: 'Creates one or more translations from a locked master asset using only live supported language labels, an explicit speed/precision choice, exact billing approval, and provider idempotency.',
    inputShape: HEYGEN_TRANSLATION_CREATE_INPUT,
    endpoint: 'POST /v3/video-translations',
    flag: 'ENABLE_HEYGEN_TRANSLATION_WRITES',
    body: (input) => ({
      video: { type: 'asset_id', asset_id: input.source_asset_id },
      title: input.title,
      output_languages: input.output_languages,
      input_language: input.input_language,
      speaker_num: input.speaker_num,
      mode: input.mode,
      translate_audio_only: input.translate_audio_only,
      keep_the_same_format: input.keep_the_same_format,
    }),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_proofread_create_preflight',
    description: 'Creates an idempotent proofread session for a locked English master before localization. Direct final translation remains separate and owner-approved.',
    inputShape: HEYGEN_PROOFREAD_CREATE_INPUT,
    endpoint: 'POST /v3/video-translations/proofreads',
    flag: 'ENABLE_HEYGEN_TRANSLATION_WRITES',
    body: (input) => ({
      video: { type: 'asset_id', asset_id: input.source_asset_id },
      title: input.title,
      output_languages: input.output_languages,
      brand_glossary_id: input.brand_glossary_id,
      speaker_num: input.speaker_num,
      mode: input.mode,
    }),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_proofread_generate_preflight',
    description: 'Starts final generation only from an approved proofread digest with exact owner/billing approval and provider idempotency.',
    inputShape: HEYGEN_PROOFREAD_GENERATE_INPUT,
    endpoint: 'POST /v3/video-translations/proofreads/{proofread_id}/generate',
    flag: 'ENABLE_HEYGEN_TRANSLATION_WRITES',
    body: () => ({ captions: false, translate_audio_only: false }),
  });
  registerDarkTool(server, callerHash, {
    name: 'heygen_speech_preview_create_preflight',
    description: 'Generates a bounded Starfish-compatible voice preview from text/SSML. This action cannot clone, train, delete, or mutate a voice and requires separate owner/billing approval.',
    inputShape: HEYGEN_SPEECH_PREVIEW_CREATE_INPUT,
    endpoint: 'POST /v3/voices/speech',
    flag: 'ENABLE_HEYGEN_TTS_WRITES',
    body: (input) => ({
      text: input.text,
      voice_id: input.voice_id,
      input_type: input.input_type ?? 'text',
      speed: input.speed ?? 1,
      language: input.language,
      locale: input.locale,
    }),
  });

  registerTool(server, {
    name: 'heygen_avatar_look_name_update',
    category: 'write_simple',
    annotations: {
      title: 'HeyGen: rename an avatar Look',
      description: 'Updates only the display name of one photo-avatar or Digital Twin Look through PATCH /v3/avatars/looks/{look_id}. CRO/CTO only, audited, no credit use, no tags, delete, consent, training, or generic metadata surface.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: HEYGEN_AVATAR_LOOK_NAME_UPDATE_INPUT,
    outputShape: {
      mode: z.string(),
      updated: z.boolean(),
      request_sha256: z.string(),
      look: z.unknown().optional(),
      outcome: z.string(),
      error: z.string().optional(),
    },
    redactInputForLog: redact,
    shieldInputForScan: shieldProjection,
    handler: async (input, ctx) => {
      if (!['cto', 'cro'].includes(ctx.callerAgent)) {
        return refusal('heygen_avatar_look_name_update', ctx.callerAgent, ctx.dryRun);
      }
      const requestSha256 = canonicalJsonSha256({ look_id: input.look_id, name: input.name });
      if (ctx.dryRun) {
        return {
          data: { mode: 'dry_run', updated: false, request_sha256: requestSha256, outcome: 'validated' },
          summary: 'DRY RUN: Look rename validated; no provider mutation occurred.',
        };
      }
      if (!loadEnv().ENABLE_HEYGEN_METADATA_WRITES) {
        throw new Error('heygen_avatar_look_name_update is disabled by ENABLE_HEYGEN_METADATA_WRITES=false.');
      }
      const beforeRaw = await executeHeyGenRead({ kind: 'avatarLook', lookId: input.look_id }, deps);
      const before = safeLookName(beforeRaw);
      if (!['photo_avatar', 'digital_twin'].includes(String(before.avatar_type))) {
        throw new Error('HeyGen supports renaming only photo_avatar and digital_twin Looks.');
      }
      if (before.name === input.name) {
        return {
          data: { mode: 'live', updated: false, request_sha256: requestSha256, look: before, outcome: 'already_current' },
          summary: `HeyGen Look ${input.look_id} already has the requested name.`,
        };
      }
      const accessToken = await getHeyGenAccessToken({ deps });
      const guard = await heyGenApiGet('/v3/users/me', accessToken, {}, deps);
      if (!guard.ok) throw new Error(`HeyGen subscription guard failed (HTTP ${guard.status}).`);
      parseHeyGenBillingSnapshot(guard.body, new Date(deps.now()).toISOString());
      let response;
      try {
        response = await heyGenApiPatch(`/v3/avatars/looks/${input.look_id}`, accessToken, { name: input.name }, deps);
      } catch {
        const reconciledRaw = await executeHeyGenRead({ kind: 'avatarLook', lookId: input.look_id }, deps);
        const reconciled = safeLookName(reconciledRaw);
        if (reconciled.name === input.name) {
          return {
            data: { mode: 'live', updated: true, request_sha256: requestSha256, look: reconciled, outcome: 'reconciled_after_ambiguity' },
            audit: { before, after: reconciled },
            summary: `HeyGen Look ${input.look_id} rename reconciled after an ambiguous provider response.`,
          };
        }
        throw new Error('HeyGen Look rename outcome is unknown; no automatic retry was attempted.');
      }
      if (!response.ok) throw new Error(`HeyGen Look rename failed (HTTP ${response.status}); no automatic retry was attempted.`);
      const after = safeLookName(response.body);
      if (after.look_id !== input.look_id || after.name !== input.name) {
        throw new Error('HeyGen Look rename returned an unexpected resource; no automatic retry was attempted.');
      }
      return {
        data: { mode: 'live', updated: true, request_sha256: requestSha256, look: after, outcome: 'updated' },
        audit: { before, after },
        summary: `HeyGen Look ${input.look_id} renamed successfully.`,
      };
    },
  }, callerHash);
}
