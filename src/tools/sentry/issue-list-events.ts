import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEventsForIssue } from '../../sentry/full-client.js';

export function registerSentryIssueListEvents(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_issue_list_events',
    category: 'read',
    annotations: {
      title: 'List events for a Sentry issue',
      description: 'List the raw events (occurrences) associated with a Sentry issue. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      issue_id: z.string().min(1).describe('Sentry issue ID.'),
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      full: z.boolean().optional().describe('Return full event payload (default false).'),
    },
    outputShape: { events: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const events = await listEventsForIssue(input.issue_id, input.project_slug, input.full);
      return { data: { events, count: events.length }, summary: `${events.length} event(s) for issue ${input.issue_id}.` };
    },
  }, callerHash);
}
