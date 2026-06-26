import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjectTags } from '../../sentry/full-client.js';

export function registerSentryProjectListTags(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_list_tags',
    category: 'read',
    annotations: {
      title: 'List tags for a Sentry project',
      description: 'List all tag keys seen in a Sentry project. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
    },
    outputShape: { tags: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const tags = await listProjectTags(input.project_slug);
      return { data: { tags, count: tags.length }, summary: `${tags.length} tag key(s) in project "${input.project_slug}".` };
    },
  }, callerHash);
}
