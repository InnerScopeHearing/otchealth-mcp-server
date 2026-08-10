/** HeyGen OAuth pairing and core discovery; production reads and bounded video controls register last. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  executeHeyGenPromptAvatarCreate,
  executeHeyGenRead,
  getHeyGenPairingStatus,
  HEYGEN_LOCALE_RE,
  HEYGEN_SAFE_ID_RE,
  startHeyGenPairing,
  type HeyGenBrokerDeps,
  defaultHeyGenBrokerDeps,
} from './broker.js';
import {
  registerTool,
  type CallerHashProvider,
  type ToolResultPayload,
} from '../registry.js';
import {
  HEYGEN_CREATION_TOOLS,
  HEYGEN_DATA_LANES,
  HEYGEN_PAIRING_TOOLS,
  isHeyGenToolAllowed,
  type HeyGenToolName,
} from './access.js';
import {
  redactHeyGenPromptAvatarInputForLog,
  redactHeyGenVoiceDesignInputForLog,
} from './redaction.js';
import { registerHeyGenProductionTools } from './production-tools.js';
import { isHeyGenProviderWriteEnabled } from './write-gate.js';
import { registerHeyGenLookTools } from './look-tools.js';
import { registerHeyGenFutureTools } from './future-tools.js';

export { isHeyGenToolAllowed } from './access.js';

export function heyGenLaneRefusal(toolName: HeyGenToolName, caller: string | undefined | null): ToolResultPayload {
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

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const PAIR_ID = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .describe('43-character one-time pairing id returned by heygen_pairing_start.');
const SAFE_ID = z
  .string()
  .regex(HEYGEN_SAFE_ID_RE, 'id must contain only letters, digits, underscore, or hyphen');
const PAGINATION_TOKEN = z.string().max(4096).optional().describe('Opaque next_token from a prior response.');
const BCP47_LOCALE = z
  .string()
  .regex(HEYGEN_LOCALE_RE, 'locale must be a BCP-47-like tag such as en-US or pt-BR');

export const HEYGEN_AVATAR_GROUPS_LIST_INPUT = {
  ownership: z.enum(['public', 'private']).optional(),
  limit: z.number().int().min(1).max(50).optional().describe('Results per page (official range 1-50; default 20).'),
  token: PAGINATION_TOKEN,
} as const;

export const HEYGEN_AVATAR_GROUP_GET_INPUT = {
  group_id: SAFE_ID.describe('Strict URL-safe avatar group id.'),
} as const;

export const HEYGEN_AVATAR_LOOKS_LIST_INPUT = {
  group_id: SAFE_ID.optional().describe('Optional strict URL-safe avatar group id.'),
  avatar_type: z.enum(['studio_avatar', 'digital_twin', 'photo_avatar']).optional(),
  ownership: z.enum(['public', 'private']).optional(),
  limit: z.number().int().min(1).max(50).optional().describe('Results per page (official range 1-50; default 20).'),
  token: PAGINATION_TOKEN,
} as const;

export const HEYGEN_AVATAR_LOOK_GET_INPUT = {
  look_id: SAFE_ID.describe('Strict URL-safe avatar look id.'),
} as const;

export const HEYGEN_VOICES_LIST_INPUT = {
  type: z.enum(['public', 'private']).optional().describe('Voice type; upstream default is public.'),
  engine: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  language: z.string().trim().min(1).max(64).optional(),
  gender: z.enum(['male', 'female']).optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Results per page (official range 1-100; default 20).'),
  token: PAGINATION_TOKEN,
} as const;

export const HEYGEN_VOICE_DESIGN_INPUT = {
  prompt: z.string().trim().min(1).max(1000).describe('Natural-language description of the desired existing voice.'),
  gender: z.enum(['male', 'female']).optional(),
  locale: BCP47_LOCALE.optional(),
  seed: z.number().int().min(0).optional(),
} as const;

export const HEYGEN_PROMPT_AVATAR_CREATE_INPUT = {
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(1000),
  avatar_group_id: SAFE_ID.optional().describe('Optional strict URL-safe existing avatar group id.'),
  confirm_credit_use: z.boolean().optional().describe('Must be true for a real creation; may be omitted for dry_run preview.'),
  confirmed_premium_credits_before: z.number().int().min(0).optional().describe('Required for real creation: exact integer premium-credit balance most recently reviewed by the caller.'),
} as const;

export function registerHeyGenTools(
  server: McpServer,
  callerHash: CallerHashProvider,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): void {
  registerTool(
    server,
    {
      name: 'heygen_pairing_start',
      category: 'write_simple',
      annotations: {
        title: 'HeyGen: start one-time OAuth pairing (CTO only)',
        description:
          'Creates a cryptographically random one-time pairing id valid for 15 minutes. CTO-only. Re-call with dry_run:false to create it; submit the official CLI OAuth credentials to POST /heygen/pair using the documented base64 header.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: {},
      outputShape: {
        pair_id: z.string().optional(),
        status: z.string(),
        expires_at: z.string().nullable(),
        pairing_path: z.string(),
        error: z.string().optional(),
      },
      handler: async (_input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_pairing_start', ctx.callerAgent)) return heyGenLaneRefusal('heygen_pairing_start', ctx.callerAgent);
        if (ctx.dryRun) {
          return {
            data: {
              status: 'dry_run',
              expires_at: null,
              pairing_path: '/heygen/pair',
            },
            summary: 'DRY RUN: no HeyGen pairing id was created. Re-call with dry_run:false to create a 15-minute one-time id.',
          };
        }
        const doc = await startHeyGenPairing(deps);
        return {
          data: {
            pair_id: doc.id,
            status: doc.status,
            expires_at: doc.expiresAt,
            pairing_path: '/heygen/pair',
          },
          summary:
            'HeyGen pairing id created for 15 minutes. POST exactly {"pair_id":"…"} to /heygen/pair and send the base64-encoded official credentials JSON only in x-heygen-oauth-credentials. The id is one-time and is consumed before credential validation.',
          // Deliberately no audit.before/after: pair_id is a short-lived capability and does not need
          // to be duplicated into audit logs. The normal tool audit still records success/correlation.
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_pairing_status',
      category: 'read',
      annotations: {
        title: 'HeyGen: check one-time OAuth pairing status (CTO only)',
        description: 'Checks a one-time HeyGen pairing id. CTO-only. Never returns OAuth credential material.',
        ...READ_ANNOTATIONS,
        openWorldHint: false,
      },
      inputShape: { pair_id: PAIR_ID },
      outputShape: {
        pair_id: z.string(),
        status: z.string(),
        expires_at: z.string().nullable(),
        completed_at: z.string().nullable(),
        failure_code: z.string().nullable(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_pairing_status', ctx.callerAgent)) return heyGenLaneRefusal('heygen_pairing_status', ctx.callerAgent);
        const status = await getHeyGenPairingStatus(input.pair_id, deps);
        return {
          data: {
            pair_id: status.pairId,
            status: status.status,
            expires_at: status.expiresAt,
            completed_at: status.completedAt,
            failure_code: status.failureCode,
          },
          summary: `HeyGen pairing ${status.pairId}: ${status.status}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_account_get',
      category: 'read',
      annotations: {
        title: 'HeyGen: get subscription account',
        description:
          'Returns GET /v3/users/me only after verifying billing_type=subscription with a populated subscription. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: {},
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (_input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_account_get', ctx.callerAgent)) return heyGenLaneRefusal('heygen_account_get', ctx.callerAgent);
        const body = await executeHeyGenRead({ kind: 'account' }, deps);
        return { data: { body }, summary: 'HeyGen subscription account retrieved.' };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_videos_list',
      category: 'read',
      annotations: {
        title: 'HeyGen: list videos',
        description:
          'Read-only GET /v3/videos with official pagination/folder/title filters. Runs the subscription guard immediately before the target request. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: {
        limit: z.number().int().min(1).max(100).optional().describe('Maximum videos per page (official range 1-100; default 10).'),
        token: z.string().max(4096).optional().describe('Opaque next_token from a prior response.'),
        folder_id: z.string().max(512).optional().describe('Filter by folder id.'),
        title: z.string().max(512).optional().describe('Filter by title substring.'),
      },
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_videos_list', ctx.callerAgent)) return heyGenLaneRefusal('heygen_videos_list', ctx.callerAgent);
        const body = await executeHeyGenRead(
          {
            kind: 'videos',
            limit: input.limit,
            token: input.token,
            folderId: input.folder_id,
            title: input.title,
          },
          deps,
        );
        return { data: { body }, summary: 'HeyGen videos retrieved.' };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_video_get',
      category: 'read',
      annotations: {
        title: 'HeyGen: get video',
        description:
          'Read-only GET /v3/videos/{video_id}. Runs the subscription guard immediately before the target request. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: {
        // Keep path construction non-ambiguous. In particular, dot-segments such as ".." would be
        // normalized by WHATWG URL and could escape /v3/videos/{id} even after encodeURIComponent.
        video_id: SAFE_ID.describe('Strict URL-safe video id.'),
      },
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_video_get', ctx.callerAgent)) return heyGenLaneRefusal('heygen_video_get', ctx.callerAgent);
        const body = await executeHeyGenRead({ kind: 'video', videoId: input.video_id }, deps);
        return { data: { body }, summary: `HeyGen video ${input.video_id} retrieved.` };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_video_agent_styles_list',
      category: 'read',
      annotations: {
        title: 'HeyGen: list Video Agent styles',
        description:
          'Read-only GET /v3/video-agents/styles with official tag/pagination filters. Runs the subscription guard immediately before the target request. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: {
        tag: z.string().max(256).optional().describe('Filter by style tag.'),
        limit: z.number().int().min(1).max(100).optional().describe('Results per page (official range 1-100; default 20).'),
        token: PAGINATION_TOKEN,
      },
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_video_agent_styles_list', ctx.callerAgent)) return heyGenLaneRefusal('heygen_video_agent_styles_list', ctx.callerAgent);
        const body = await executeHeyGenRead(
          { kind: 'styles', tag: input.tag, limit: input.limit, token: input.token },
          deps,
        );
        return { data: { body }, summary: 'HeyGen Video Agent styles retrieved.' };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_avatar_groups_list',
      category: 'read',
      annotations: {
        title: 'HeyGen: list avatar groups',
        description:
          'Read-only GET /v3/avatars with official ownership and pagination filters. Runs GET /v3/users/me immediately before the target. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: HEYGEN_AVATAR_GROUPS_LIST_INPUT,
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_avatar_groups_list', ctx.callerAgent)) return heyGenLaneRefusal('heygen_avatar_groups_list', ctx.callerAgent);
        const body = await executeHeyGenRead(
          { kind: 'avatarGroups', ownership: input.ownership, limit: input.limit, token: input.token },
          deps,
        );
        return { data: { body }, summary: 'HeyGen avatar groups retrieved.' };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_avatar_group_get',
      category: 'read',
      annotations: {
        title: 'HeyGen: get avatar group',
        description:
          'Read-only GET /v3/avatars/{group_id}. Runs GET /v3/users/me immediately before the target. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: HEYGEN_AVATAR_GROUP_GET_INPUT,
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_avatar_group_get', ctx.callerAgent)) return heyGenLaneRefusal('heygen_avatar_group_get', ctx.callerAgent);
        const body = await executeHeyGenRead({ kind: 'avatarGroup', groupId: input.group_id }, deps);
        return { data: { body }, summary: `HeyGen avatar group ${input.group_id} retrieved.` };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_avatar_looks_list',
      category: 'read',
      annotations: {
        title: 'HeyGen: list avatar looks',
        description:
          'Read-only GET /v3/avatars/looks with official group_id, avatar_type, ownership, and pagination filters. Runs GET /v3/users/me immediately before the target. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: HEYGEN_AVATAR_LOOKS_LIST_INPUT,
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_avatar_looks_list', ctx.callerAgent)) return heyGenLaneRefusal('heygen_avatar_looks_list', ctx.callerAgent);
        const body = await executeHeyGenRead(
          {
            kind: 'avatarLooks',
            groupId: input.group_id,
            avatarType: input.avatar_type,
            ownership: input.ownership,
            limit: input.limit,
            token: input.token,
          },
          deps,
        );
        return { data: { body }, summary: 'HeyGen avatar looks retrieved.' };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_avatar_look_get',
      category: 'read',
      annotations: {
        title: 'HeyGen: get avatar look',
        description:
          'Read-only GET /v3/avatars/looks/{look_id}. Runs GET /v3/users/me immediately before the target. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: HEYGEN_AVATAR_LOOK_GET_INPUT,
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_avatar_look_get', ctx.callerAgent)) return heyGenLaneRefusal('heygen_avatar_look_get', ctx.callerAgent);
        const body = await executeHeyGenRead({ kind: 'avatarLook', lookId: input.look_id }, deps);
        return { data: { body }, summary: `HeyGen avatar look ${input.look_id} retrieved.` };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_voices_list',
      category: 'read',
      annotations: {
        title: 'HeyGen: list voices',
        description:
          'Read-only GET /v3/voices with official type, engine, language, gender, and pagination filters. Type defaults upstream to public. Runs GET /v3/users/me immediately before the target. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: HEYGEN_VOICES_LIST_INPUT,
      outputShape: { body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_voices_list', ctx.callerAgent)) return heyGenLaneRefusal('heygen_voices_list', ctx.callerAgent);
        const body = await executeHeyGenRead(
          {
            kind: 'voices',
            type: input.type,
            engine: input.engine,
            language: input.language,
            gender: input.gender,
            limit: input.limit,
            token: input.token,
          },
          deps,
        );
        return { data: { body }, summary: 'HeyGen voices retrieved.' };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_voice_design',
      category: 'read',
      annotations: {
        title: 'HeyGen: design a voice by semantic search',
        description:
          'POST /v3/voices semantic search over existing voices. Returns up to 3 matches and consumes no generation quota. Runs GET /v3/users/me immediately before the target. Internal cto/exec/coo/cro/cpo/developer lanes only.',
        ...READ_ANNOTATIONS,
      },
      inputShape: HEYGEN_VOICE_DESIGN_INPUT,
      outputShape: { body: z.unknown(), error: z.string().optional() },
      redactInputForLog: redactHeyGenVoiceDesignInputForLog,
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_voice_design', ctx.callerAgent)) return heyGenLaneRefusal('heygen_voice_design', ctx.callerAgent);
        const body = await executeHeyGenRead(
          {
            kind: 'voiceDesign',
            prompt: input.prompt,
            gender: input.gender,
            locale: input.locale,
            seed: input.seed,
          },
          deps,
        );
        return { data: { body }, summary: 'HeyGen existing-voice matches retrieved; no generation quota was consumed.' };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'heygen_prompt_avatar_create',
      category: 'write_simple',
      annotations: {
        title: 'HeyGen: create one prompt avatar (CTO only)',
        description:
          'Creates exactly one prompt avatar via POST /v3/avatars. CTO-only. Requires confirm_credit_use=true and an exact live premium-credit balance snapshot; the POST is refused if that balance changed or is below 1. Supports only {type:"prompt", name, prompt, optional avatar_group_id}; no reference images, photo, digital twin, upload, video, or TTS surface.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: HEYGEN_PROMPT_AVATAR_CREATE_INPUT,
      outputShape: {
        body: z.unknown().optional(),
        plan: z.string().optional(),
        premium_credits_before: z.number().int().optional(),
        status: z.string().optional(),
        error: z.string().optional(),
      },
      redactInputForLog: redactHeyGenPromptAvatarInputForLog,
      handler: async (input, ctx) => {
        if (!isHeyGenToolAllowed('heygen_prompt_avatar_create', ctx.callerAgent)) return heyGenLaneRefusal('heygen_prompt_avatar_create', ctx.callerAgent);
        if (ctx.dryRun) {
          return {
            data: { status: 'dry_run' },
            summary:
              `DRY RUN: no HeyGen avatar was created for ${input.name}. Re-call with dry_run:false only after confirming the exact current premium-credit balance.`,
          };
        }
        if (!isHeyGenProviderWriteEnabled('ENABLE_HEYGEN_PROMPT_AVATAR_WRITES')) {
          throw new Error('HeyGen prompt-avatar writes are disabled. Dry-run remains available.');
        }
        const result = await executeHeyGenPromptAvatarCreate(
          {
            name: input.name,
            prompt: input.prompt,
            avatarGroupId: input.avatar_group_id,
            confirmCreditUse: input.confirm_credit_use === true,
            confirmedPremiumCreditsBefore: input.confirmed_premium_credits_before ?? -1,
          },
          deps,
        );
        return {
          data: {
            body: result.body,
            plan: result.plan,
            premium_credits_before: result.premiumCreditsBefore,
          },
          summary:
            `HeyGen prompt avatar creation accepted on plan ${result.plan} with ${result.premiumCreditsBefore} premium credit(s) before the request.`,
        };
      },
    },
    callerHash,
  );

  registerHeyGenProductionTools(server, callerHash, deps);
  registerHeyGenLookTools(server, callerHash, deps);
  registerHeyGenFutureTools(server, callerHash, deps);
}
