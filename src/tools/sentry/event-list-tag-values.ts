import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTagValues } from '../../sentry/full-client.js';

export function registerSentryEventListTagValues(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_event_list_tag_values',
    category: 'read',
    annotations: {
      title: 'List tag values for a project (events)',
      description: 'Return values seen for a given tag key across events in a project. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      key: z.string().min(1).describe('Tag key, e.g. "browser", "environment", "release".'),
    },
    outputShape: { values: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const values = await listTagValues(input.project_slug, input.key);
      return { data: { values, count: values.length }, summary: `${values.length} values for tag "${input.key}" in "${input.project_slug}".` };
    },
  }, callerHash);
}
