import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTeams } from '../../sentry/full-client.js';

export function registerSentryTeamList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_team_list',
    category: 'read',
    annotations: {
      title: 'List Sentry teams',
      description: 'List all teams in the Sentry organization.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: { teams: z.array(z.unknown()), count: z.number() },
    handler: async () => {
      const teams = await listTeams();
      return { data: { teams, count: teams.length }, summary: `${teams.length} team(s).` };
    },
  }, callerHash);
}
