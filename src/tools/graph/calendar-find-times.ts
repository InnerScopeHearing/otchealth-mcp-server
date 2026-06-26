import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { findMeetingTimes } from '../../graph/full-client.js';

export function registerGraphCalendarFindTimes(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_calendar_find_times',
    category: 'read',
    annotations: {
      title: 'Find meeting times / free-busy lookup',
      description: 'Query free/busy availability for a list of attendees via POST /users/{sender}/calendar/getSchedule. Returns availability windows to identify open meeting slots. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      attendee_emails: z.string().describe('Comma-separated email addresses to check availability for.'),
      start_datetime: z.string().describe('Range start as ISO-8601 datetime string, e.g. "2026-07-01T08:00:00".'),
      end_datetime: z.string().describe('Range end as ISO-8601 datetime string, e.g. "2026-07-01T18:00:00".'),
      time_zone: z.string().optional().describe('IANA timezone for the query window (default UTC).'),
      slot_duration_minutes: z.number().int().min(15).max(480).optional().describe('Desired meeting duration in minutes for slot interval (default 30).'),
    },
    outputShape: {
      schedules: z.array(z.object({
        email: z.string(),
        availability_view: z.string().describe('Encoded availability string (0=free, 1=tentative, 2=busy, 3=oof, 4=workingElsewhere).'),
        busy_blocks: z.array(z.object({ start: z.string(), end: z.string(), status: z.string() })),
      })),
    },
    handler: async (input, _ctx) => {
      const emails = input.attendee_emails.split(',').map((e: string) => e.trim()).filter(Boolean);
      const result = await findMeetingTimes({
        attendeeEmails: emails,
        startDateTime: input.start_datetime,
        endDateTime: input.end_datetime,
        timeZone: input.time_zone,
        meetingDurationMinutes: input.slot_duration_minutes,
      });
      const schedules = (result.value ?? []).map((s: any) => ({
        email: s.scheduleId ?? '',
        availability_view: s.availabilityView ?? '',
        busy_blocks: (s.scheduleItems ?? []).map((item: any) => ({
          start: item.start?.dateTime ?? '',
          end: item.end?.dateTime ?? '',
          status: item.status ?? '',
        })),
      }));
      return {
        data: { schedules },
        summary: `Retrieved availability for ${schedules.length} attendee(s).`,
      };
    },
  }, callerHash);
}
