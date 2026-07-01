import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcSetAdminAway } from '../../intercom/full-client.js';

export function registerIntercomAdminSetAway(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_admin_set_away',
    category: 'write_simple',
    annotations: {
      title: 'Set an Intercom admin away/available mode',
      description: 'Toggle away mode for an admin via PUT /admins/:id/away. When away_mode_reassign is true, open conversations are auto-reassigned. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      admin_id: z.string().describe('Intercom admin ID.'),
      away_mode_enabled: z.boolean().describe('true = set away; false = set available.'),
      away_mode_reassign: z.boolean().describe('true = auto-reassign open conversations when going away.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      admin_id: z.string(),
      away_mode_enabled: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, admin_id: input.admin_id, away_mode_enabled: input.away_mode_enabled },
          audit: { before: null, after: input },
          summary: `DRY RUN: would set admin ${input.admin_id} away_mode_enabled=${input.away_mode_enabled}. Pass dry_run=false to apply.`,
        };
      }
      await fcSetAdminAway({
        admin_id: input.admin_id,
        away_mode_enabled: input.away_mode_enabled,
        away_mode_reassign: input.away_mode_reassign,
      });
      return {
        data: { executed: true, dry_run: false, admin_id: input.admin_id, away_mode_enabled: input.away_mode_enabled },
        audit: { before: null, after: input },
        summary: `Admin ${input.admin_id} away mode set to ${input.away_mode_enabled}.`,
      };
    },
  }, callerHash);
}
