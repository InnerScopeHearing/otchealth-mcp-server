import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEvents } from '../../graph/full-client.js';

export function registerGraphEventList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_event_list',
    category: 'read',
    annotations: {
      title: 'List calendar events',
      description: 'List events on the COO calendar via GET /users/{sender}/events. Supports OData $filter for date range queries. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      top: z.number().int().min(1).max(100).optional().describe('Number of events to return (max 100, default 25).'),
      filter: z.string().optional().describe('OData $filter, e.g. "start/dateTime ge \'2026-07-01T00:00:00\' and end/dateTime le \'2026-07-31T23:59:59\'".'),
      calendar_id: z.string().optional().describe('Specific calendar ID (omit for default calendar).'),
    },
    outputShape: {
      events: z.array(z.object({
        id: z.string(),
        subject: z.string(),
        start: z.string(),
        end: z.string(),
        location: z.string(),
        organizer: z.string(),
        is_online_meeting: z.boolean(),
        web_link: z.string(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const events = await listEvents({
        top: input.top ?? 25,
        filter: input.filter,
        calendarId: input.calendar_id,
        select: 'id,subject,start,end,location,organizer,isOnlineMeeting,webLink',
      });
      const mapped = events.map((e: any) => ({
        id: e.id ?? '',
        subject: e.subject ?? '',
        start: e.start?.dateTime ?? '',
        end: e.end?.dateTime ?? '',
        location: e.location?.displayName ?? '',
        organizer: e.organizer?.emailAddress?.address ?? '',
        is_online_meeting: e.isOnlineMeeting ?? false,
        web_link: e.webLink ?? '',
      }));
      return {
        data: { events: mapped, count: mapped.length },
        summary: `Found ${mapped.length} calendar event(s).`,
      };
    },
  }, callerHash);
}
