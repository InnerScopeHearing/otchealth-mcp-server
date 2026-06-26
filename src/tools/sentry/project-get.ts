import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProject } from '../../sentry/full-client.js';

export function registerSentryProjectGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_get',
    category: 'read',
    annotations: {
      title: 'Get Sentry project',
      description: 'Retrieve full details for a single Sentry project by slug. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
    },
    outputShape: { project: z.unknown() },
    handler: async (input) => {
      const project = await getProject(input.project_slug);
      return { data: { project }, summary: `Project "${input.project_slug}" retrieved.` };
    },
  }, callerHash);
}
