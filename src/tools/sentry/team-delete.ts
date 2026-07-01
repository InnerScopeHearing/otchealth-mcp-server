import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteTeam } from '../../sentry/full-client.js';

export function registerSentryTeamDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_team_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Sentry team',
      description: 'Permanently delete a Sentry team. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      team_slug: z.string().min(1).describe('Team slug to delete.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), team_slug: z.string() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, team_slug: input.team_slug },
          audit: { before: null, after: { team_slug: input.team_slug } },
          summary: `DRY RUN: would permanently delete team "${input.team_slug}". Pass dry_run=false to apply.`,
        };
      }
      await deleteTeam(input.team_slug);
      return {
        data: { executed: true, dry_run: false, team_slug: input.team_slug },
        audit: { before: { team_slug: input.team_slug }, after: null },
        summary: `Team "${input.team_slug}" deleted.`,
      };
    },
  }, callerHash);
}
