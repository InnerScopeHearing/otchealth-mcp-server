import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteEvent } from '../../graph/full-client.js';

export function registerGraphEventDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_event_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a calendar event',
      description: 'Permanently delete a calendar event via DELETE /users/{sender}/events/{id}. Sends cancellation notices to attendees. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      event_id: z.string().describe('The Graph event ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      event_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, event_id: input.event_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete event ${input.event_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteEvent(input.event_id);
      return {
        data: { executed: true, dry_run: false, event_id: input.event_id },
        audit: { before: { event_id: input.event_id }, after: null },
        summary: `Event ${input.event_id} deleted.`,
      };
    },
  }, callerHash);
}
