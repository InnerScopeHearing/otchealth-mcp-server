import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getTeam } from '../../sentry/full-client.js';

export function registerSentryTeamGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_team_get',
    category: 'read',
    annotations: {
      title: 'Get a Sentry team',
      description: 'Retrieve full details for a Sentry team by slug.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      team_slug: z.string().min(1).describe('Team slug.'),
    },
    outputShape: { team: z.unknown() },
    handler: async (input) => {
      const team = await getTeam(input.team_slug);
      return { data: { team }, summary: `Team "${input.team_slug}" retrieved.` };
    },
  }, callerHash);
}
