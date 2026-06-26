import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTeamProjects } from '../../sentry/full-client.js';

export function registerSentryTeamListProjects(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_team_list_projects',
    category: 'read',
    annotations: {
      title: 'List projects for a Sentry team',
      description: 'List all projects owned by a Sentry team. MedReview PHI projects are carved out.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      team_slug: z.string().min(1).describe('Team slug.'),
    },
    outputShape: { projects: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const projects = await listTeamProjects(input.team_slug);
      return { data: { projects, count: projects.length }, summary: `${projects.length} project(s) for team "${input.team_slug}" (PHI carved out).` };
    },
  }, callerHash);
}
