import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';
import {
  ELEVATION_ROLES,
  mintSetupCode,
  SetupCodeError,
  type ElevationRole,
} from '../../auth/setup-codes.js';

const CALLER_ALLOWLIST = ['cto', 'exec'] as const;

/**
 * connector_setup_code_create -- mints a single-use owner setup code that the OAuth consent
 * interstitial (server/oauth-consent.ts, wired into GET/POST /oauth/authorize) redeems to elevate a
 * URL-only ChatGPT/Claude connector to a privileged agent lane. See docs/CHATGPT-CONNECT.md for the
 * full owner + operator flow, and auth/setup-codes.ts's header for why this cannot reopen the July
 * 2026 DCR self-mint hole.
 *
 * GATING (defense in depth, TWO independent layers):
 *   1. The Zod input shape restricts `role` to z.enum(ELEVATION_ROLES) -- 'clo-personal' or any
 *      other string is REJECTED before this handler ever runs (a standard invalid_input error).
 *   2. This handler ALSO checks ctx.callerAgent against CALLER_ALLOWLIST (cto/exec) before minting
 *      -- duplicated in catalog/governance.ts's GOVERNANCE table (pattern
 *      'connector_setup_code_create') so the central policy view and this in-handler check agree,
 *      mirroring this repo's existing convention (e.g. tools/cio/admin-access.ts's
 *      isCioAdminToolAllowed + the matching cio_admin_* GOVERNANCE rows).
 * auth/setup-codes.ts's mintSetupCode() ALSO independently refuses clo-personal at the storage
 * layer (assertMintableRole), so a caller that somehow bypassed both layers above would still be
 * refused there -- three layers deep for the one thing this tool must never do.
 */
export function registerConnectorSetupCodeCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'connector_setup_code_create',
      category: 'write_simple',
      annotations: {
        title: 'Mint an owner connector setup code (cto/exec only)',
        description:
          'Creates a single-use, short-lived setup code for the OAuth consent interstitial to elevate a URL-only ChatGPT/Claude connector to ONE named privileged role (cto/cfo/clo/coo/cro/developer -- never clo-personal). ' +
          'SECURITY: the tool RESULT contains a short-lived plaintext owner secret (the code itself). It is shown exactly once and is never recoverable afterward. Deliver it to the owner PRIVATELY (do not paste it into a shared channel, ticket, or log) -- whoever holds the code can redeem it for the granted role at the consent page.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: {
        role: z.enum(ELEVATION_ROLES).describe('The single role this code will elevate to on redemption. clo-personal is not a valid value -- it has no connector-elevation path.'),
        label: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Optional operator note, e.g. "cfo connector on Matt\'s ChatGPT". Never rendered on the consent page; for your own tracking only.'),
        ttl_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe('Minutes until the code expires if unredeemed. Default 30, maximum 1440 (24h).'),
      },
      outputShape: {
        minted: z.boolean().optional(),
        code: z.string().optional(),
        role: z.string().optional(),
        expires_at: z.string().optional(),
        ttl_minutes: z.number().optional(),
        error: z.string().optional(),
        reason: z.string().optional(),
        caller_agent: z.string().nullable().optional(),
      },
      handler: async (input, ctx: ToolContext) => {
        if (!(CALLER_ALLOWLIST as readonly string[]).includes(ctx.callerAgent)) {
          const reason = `Minting a connector setup code is limited to the ${CALLER_ALLOWLIST.join('/')} agent(s).`;
          return {
            data: {
              minted: false,
              error: 'forbidden_role',
              caller_agent: ctx.callerAgent || null,
              reason,
            },
            summary: reason,
          };
        }

        const role = input.role as ElevationRole;
        try {
          const minted = await mintSetupCode({
            role,
            createdBy: ctx.callerAgent || 'unknown',
            label: input.label,
            ttlMinutes: input.ttl_minutes,
          });
          return {
            data: {
              code: minted.code,
              role: minted.role,
              expires_at: minted.expiresAt,
              ttl_minutes: minted.ttlMinutes,
            },
            summary:
              `Setup code minted for role "${minted.role}", expires ${minted.expiresAt}. ` +
              'Deliver it to the owner PRIVATELY -- this is the only time it is shown. ' +
              'The owner redeems it at the consent page shown when the connector completes GET /oauth/authorize.',
            // Deliberately no audit.before/after: like heygen_pairing_start, a short-lived
            // capability does not need to be duplicated into the audit log's before/after fields.
          };
        } catch (e) {
          if (e instanceof SetupCodeError) {
            return {
              data: { minted: false, error: e.code, reason: e.message },
              summary: e.message,
            };
          }
          throw e;
        }
      },
    },
    callerHash,
  );
}
