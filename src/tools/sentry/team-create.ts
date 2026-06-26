import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createTeam } from '../../sentry/full-client.js';

export function registerSentryTeamCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_team_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a Sentry team',
      description: 'Create a new team in the Sentry organization. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Human-readable team name.'),
      slug: z.string().optional().describe('Optional URL-safe slug.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), team: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, team: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create team "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const team = await createTeam(input.name, input.slug);
      return {
        data: { executed: true, dry_run: false, team },
        audit: { before: null, after: input },
        summary: `Team "${input.name}" created.`,
      };
    },
  }, callerHash);
}
