/** Fixed, read-only HeyGen tool surface plus the CTO-only one-time pairing controls. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  executeHeyGenRead,
  getHeyGenPairingStatus,
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
  HEYGEN_DATA_LANES,
  HEYGEN_PAIRING_TOOLS,
  isHeyGenToolAllowed,
  type HeyGenToolName,
} from './access.js';

export { isHeyGenToolAllowed } from './access.js';

export function heyGenLaneRefusal(toolName: HeyGenToolName, caller: string | undefined | null): ToolResultPayload {
  const pairing = (HEYGEN_PAIRING_TOOLS as readonly string[]).includes(toolName);
  return {
    data: { error: 'forbidden_lane' },
    summary: pairing
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
        video_id: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, 'video_id must contain only letters, digits, underscore, or hyphen'),
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
        token: z.string().max(4096).optional().describe('Opaque next_token from a prior response.'),
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
}
