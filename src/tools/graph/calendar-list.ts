import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCalendars } from '../../graph/full-client.js';

export function registerGraphCalendarList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_calendar_list',
    category: 'read',
    annotations: {
      title: 'List calendars',
      description: 'List all calendars in the COO mailbox via GET /users/{sender}/calendars. Returns calendar IDs needed for graph_event_list with a specific calendar. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      calendars: z.array(z.object({
        id: z.string(),
        name: z.string(),
        color: z.string(),
        is_default_calendar: z.boolean(),
        can_edit: z.boolean(),
      })),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const cals = await listCalendars();
      const mapped = cals.map((c: any) => ({
        id: c.id ?? '',
        name: c.name ?? '',
        color: c.color ?? 'auto',
        is_default_calendar: c.isDefaultCalendar ?? false,
        can_edit: c.canEdit ?? false,
      }));
      return {
        data: { calendars: mapped, count: mapped.length },
        summary: `Found ${mapped.length} calendar(s).`,
      };
    },
  }, callerHash);
}
