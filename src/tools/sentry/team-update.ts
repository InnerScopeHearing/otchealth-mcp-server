import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateTeam } from '../../sentry/full-client.js';

export function registerSentryTeamUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_team_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a Sentry team',
      description: 'Rename or reslug a Sentry team. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      team_slug: z.string().min(1).describe('Current team slug.'),
      name: z.string().optional().describe('New team name.'),
      slug: z.string().optional().describe('New team slug.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), upstream_response: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, upstream_response: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update team "${input.team_slug}". Pass dry_run=false to apply.`,
        };
      }
      const result = await updateTeam(input.team_slug, { name: input.name, slug: input.slug });
      return {
        data: { executed: true, dry_run: false, upstream_response: result },
        audit: { before: null, after: input },
        summary: `Team "${input.team_slug}" updated.`,
      };
    },
  }, callerHash);
}
