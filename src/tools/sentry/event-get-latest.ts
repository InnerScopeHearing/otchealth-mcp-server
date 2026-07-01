import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getLatestEventForIssue } from '../../sentry/full-client.js';

export function registerSentryEventGetLatest(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_event_get_latest',
    category: 'read',
    annotations: {
      title: 'Get latest event for a Sentry issue',
      description: 'Return the most recent event occurrence for a given Sentry issue. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      issue_id: z.string().min(1).describe('Sentry issue ID.'),
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
    },
    outputShape: { event: z.unknown() },
    handler: async (input) => {
      const event = await getLatestEventForIssue(input.issue_id, input.project_slug);
      return { data: { event }, summary: `Latest event for issue ${input.issue_id}.` };
    },
  }, callerHash);
}
