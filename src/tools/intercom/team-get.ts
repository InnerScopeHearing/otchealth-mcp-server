import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetTeam } from '../../intercom/full-client.js';

export function registerIntercomTeamGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_team_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom team by ID',
      description: 'Retrieve a single team by its ID via GET /teams/:id. Returns admin member list.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      team_id: z.string().describe('Intercom team ID.'),
    },
    outputShape: {
      team: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const team = await fcGetTeam(input.team_id);
      return {
        data: { team },
        summary: `Team ${input.team_id} retrieved.`,
      };
    },
  }, callerHash);
}
