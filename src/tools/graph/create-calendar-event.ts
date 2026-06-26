import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCalendarEvent } from '../../graph/write-client.js';

export function registerGraphCreateCalendarEvent(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_create_calendar_event',
    category: 'write_simple',
    annotations: {
      title: 'Create a calendar event on the COO calendar',
      description: 'Create an event on coo@otchealthmart.com default calendar via Microsoft Graph POST /users/{sender}/events. Optionally adds attendees and a Teams meeting link. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      subject: z.string().describe('Event title.'),
      start_datetime: z.string().describe('Start time as ISO-8601 datetime string, e.g. "2026-07-01T09:00:00".'),
      end_datetime: z.string().describe('End time as ISO-8601 datetime string, e.g. "2026-07-01T10:00:00".'),
      time_zone: z.string().optional().describe('IANA timezone for start/end, e.g. "America/Chicago". Defaults to UTC.'),
      body: z.string().optional().describe('Event description/body (plain text or HTML).'),
      body_type: z.enum(['Text', 'HTML']).optional().describe('Body content type (default Text).'),
      location: z.string().optional().describe('Physical or virtual location name.'),
      attendees: z.string().optional().describe('Comma-separated attendee email addresses.'),
      is_online_meeting: z.boolean().optional().describe('If true, adds a Microsoft Teams meeting link.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      event_id: z.string().nullable(),
      subject: z.string(),
      online_meeting_url: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, event_id: null, subject: input.subject, online_meeting_url: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create calendar event "${input.subject}" at ${input.start_datetime}. Pass dry_run=false to apply.`,
        };
      }
      const attendeeList = input.attendees
        ? input.attendees.split(',').map((e: string) => ({ email: e.trim() })).filter(a => a.email)
        : undefined;

      const event = await createCalendarEvent({
        subject: input.subject,
        startDateTime: input.start_datetime,
        endDateTime: input.end_datetime,
        timeZone: input.time_zone,
        body: input.body,
        bodyType: input.body_type,
        location: input.location,
        attendees: attendeeList,
        isOnlineMeeting: input.is_online_meeting,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          event_id: event.id,
          subject: event.subject,
          online_meeting_url: event.onlineMeetingUrl,
        },
        audit: { before: null, after: input },
        summary: `Calendar event "${event.subject}" created (id: ${event.id})${event.onlineMeetingUrl ? ' with Teams link.' : '.'}`,
      };
    },
  }, callerHash);
}
