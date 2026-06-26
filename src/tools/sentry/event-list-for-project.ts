import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEventsForProject } from '../../sentry/full-client.js';

export function registerSentryEventListForProject(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_event_list_for_project',
    category: 'read',
    annotations: {
      title: 'List Sentry events for a project',
      description: 'List recent raw events for a project. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      full: z.boolean().optional().describe('Return full event payload (default false).'),
    },
    outputShape: { events: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const events = await listEventsForProject(input.project_slug, input.full);
      return { data: { events, count: events.length }, summary: `${events.length} event(s) in project "${input.project_slug}".` };
    },
  }, callerHash);
}
