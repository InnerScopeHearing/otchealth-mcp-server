import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjectUsers } from '../../sentry/full-client.js';

export function registerSentryProjectListUsers(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_list_users',
    category: 'read',
    annotations: {
      title: 'List users seen in a Sentry project',
      description: 'List users (end-users who experienced errors) seen in a Sentry project. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
    },
    outputShape: { users: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const users = await listProjectUsers(input.project_slug);
      return { data: { users, count: users.length }, summary: `${users.length} user(s) in project "${input.project_slug}".` };
    },
  }, callerHash);
}
