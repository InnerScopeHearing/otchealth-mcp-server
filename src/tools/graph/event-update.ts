import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateEvent } from '../../graph/full-client.js';

export function registerGraphEventUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_event_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a calendar event',
      description: 'Update fields on an existing calendar event via PATCH /users/{sender}/events/{id}. Supports rescheduling, renaming, changing attendees, location, or show-as status. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      event_id: z.string().describe('The Graph event ID to update.'),
      subject: z.string().optional().describe('New event title.'),
      start_datetime: z.string().optional().describe('New start time as ISO-8601 datetime string.'),
      end_datetime: z.string().optional().describe('New end time as ISO-8601 datetime string.'),
      time_zone: z.string().optional().describe('IANA timezone for start/end times (default UTC).'),
      body: z.string().optional().describe('Updated event description.'),
      body_type: z.enum(['Text', 'HTML']).optional().describe('Body content type.'),
      location: z.string().optional().describe('Updated location name.'),
      attendees: z.string().optional().describe('Comma-separated attendee email addresses (replaces existing list).'),
      is_online_meeting: z.boolean().optional().describe('Enable or disable Teams meeting link.'),
      show_as: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']).optional().describe('Calendar availability status.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      event_id: z.string(),
      subject: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, event_id: input.event_id, subject: input.subject ?? null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update event ${input.event_id}. Pass dry_run=false to apply.`,
        };
      }
      const attendeeList = input.attendees
        ? input.attendees.split(',').map((e: string) => ({ email: e.trim() })).filter(a => a.email)
        : undefined;
      const updated = await updateEvent({
        eventId: input.event_id,
        subject: input.subject,
        startDateTime: input.start_datetime,
        endDateTime: input.end_datetime,
        timeZone: input.time_zone,
        body: input.body,
        bodyType: input.body_type,
        location: input.location,
        attendees: attendeeList,
        isOnlineMeeting: input.is_online_meeting,
        showAs: input.show_as,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          event_id: updated.id ?? input.event_id,
          subject: updated.subject ?? null,
        },
        audit: { before: null, after: input },
        summary: `Event ${input.event_id} updated successfully.`,
      };
    },
  }, callerHash);
}
