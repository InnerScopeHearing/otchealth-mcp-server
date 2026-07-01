import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListTeams } from '../../intercom/full-client.js';

export function registerIntercomTeamList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_team_list',
    category: 'read',
    annotations: {
      title: 'List Intercom teams',
      description: 'Retrieve all teams in the Intercom workspace via GET /teams. Returns team IDs, names, and admin member lists.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      teams: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const resp = await fcListTeams();
      const teams = resp.teams ?? resp.data ?? [];
      return {
        data: { teams, count: teams.length },
        summary: `Found ${teams.length} team(s).`,
      };
    },
  }, callerHash);
}
