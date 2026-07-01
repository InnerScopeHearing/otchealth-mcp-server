import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEvent } from '../../graph/full-client.js';

export function registerGraphEventGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_event_get',
    category: 'read',
    annotations: {
      title: 'Get a single calendar event',
      description: 'Retrieve the full details of a calendar event by ID via GET /users/{sender}/events/{id}. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      event_id: z.string().describe('The Graph event ID to retrieve.'),
    },
    outputShape: {
      id: z.string(),
      subject: z.string(),
      body_preview: z.string(),
      start: z.string(),
      end: z.string(),
      time_zone: z.string(),
      location: z.string(),
      organizer: z.string(),
      attendees: z.array(z.string()),
      is_online_meeting: z.boolean(),
      online_meeting_url: z.string().nullable(),
      show_as: z.string(),
      web_link: z.string(),
      recurrence: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const e = await getEvent(input.event_id);
      const attendees: string[] = (e.attendees ?? []).map((a: any) => a.emailAddress?.address ?? '');
      return {
        data: {
          id: e.id ?? '',
          subject: e.subject ?? '',
          body_preview: (e.bodyPreview ?? '').slice(0, 300),
          start: e.start?.dateTime ?? '',
          end: e.end?.dateTime ?? '',
          time_zone: e.start?.timeZone ?? 'UTC',
          location: e.location?.displayName ?? '',
          organizer: e.organizer?.emailAddress?.address ?? '',
          attendees,
          is_online_meeting: e.isOnlineMeeting ?? false,
          online_meeting_url: e.onlineMeetingUrl ?? null,
          show_as: e.showAs ?? 'busy',
          web_link: e.webLink ?? '',
          recurrence: e.recurrence !== null && e.recurrence !== undefined,
        },
        summary: `Retrieved event "${e.subject}" on ${e.start?.dateTime ?? 'unknown date'}.`,
      };
    },
  }, callerHash);
}
