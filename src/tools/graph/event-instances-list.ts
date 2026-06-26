import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEventInstances } from '../../graph/full-client.js';

export function registerGraphEventInstancesList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_event_instances_list',
    category: 'read',
    annotations: {
      title: 'List instances of a recurring event',
      description: 'List occurrences of a recurring calendar event within a date range via GET /users/{sender}/events/{id}/instances. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      event_id: z.string().describe('The recurring event (series master) ID.'),
      start_datetime: z.string().describe('Range start as ISO-8601 datetime string.'),
      end_datetime: z.string().describe('Range end as ISO-8601 datetime string.'),
      top: z.number().int().min(1).max(100).optional().describe('Max number of instances to return (default 25).'),
    },
    outputShape: {
      instances: z.array(z.object({
        id: z.string(),
        subject: z.string(),
        start: z.string(),
        end: z.string(),
        is_cancelled: z.boolean(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const instances = await listEventInstances({
        eventId: input.event_id,
        startDateTime: input.start_datetime,
        endDateTime: input.end_datetime,
        top: input.top ?? 25,
      });
      const mapped = instances.map((e: any) => ({
        id: e.id ?? '',
        subject: e.subject ?? '',
        start: e.start?.dateTime ?? '',
        end: e.end?.dateTime ?? '',
        is_cancelled: e.isCancelled ?? false,
      }));
      return {
        data: { instances: mapped, count: mapped.length },
        summary: `Found ${mapped.length} instance(s) of recurring event ${input.event_id}.`,
      };
    },
  }, callerHash);
}
