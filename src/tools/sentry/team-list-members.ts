import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTeamMembers } from '../../sentry/full-client.js';

export function registerSentryTeamListMembers(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_team_list_members',
    category: 'read',
    annotations: {
      title: 'List members of a Sentry team',
      description: 'List all members belonging to a Sentry team.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      team_slug: z.string().min(1).describe('Team slug.'),
    },
    outputShape: { members: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const members = await listTeamMembers(input.team_slug);
      return { data: { members, count: members.length }, summary: `${members.length} member(s) in team "${input.team_slug}".` };
    },
  }, callerHash);
}
