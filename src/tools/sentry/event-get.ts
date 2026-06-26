import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEvent } from '../../sentry/full-client.js';

export function registerSentryEventGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_event_get',
    category: 'read',
    annotations: {
      title: 'Get a Sentry event',
      description: 'Retrieve a single raw event by event ID within a project. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      event_id: z.string().min(1).describe('Sentry event ID (UUID or hex).'),
    },
    outputShape: { event: z.unknown() },
    handler: async (input) => {
      const event = await getEvent(input.project_slug, input.event_id);
      return { data: { event }, summary: `Event ${input.event_id} in project "${input.project_slug}".` };
    },
  }, callerHash);
}
