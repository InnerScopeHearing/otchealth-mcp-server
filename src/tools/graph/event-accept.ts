import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { acceptEvent } from '../../graph/full-client.js';

export function registerGraphEventAccept(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_event_accept',
    category: 'write_simple',
    annotations: {
      title: 'Accept a calendar event invitation',
      description: 'Accept a calendar event invitation via POST /users/{sender}/events/{id}/accept. Sends an acceptance response to the organizer. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      event_id: z.string().describe('The Graph event ID to accept.'),
      comment: z.string().optional().describe('Optional message to include with the acceptance.'),
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
          summary: `DRY RUN: would accept event ${input.event_id}. Pass dry_run=false to apply.`,
        };
      }
      await acceptEvent(input.event_id, input.comment);
      return {
        data: { executed: true, dry_run: false, event_id: input.event_id },
        audit: { before: null, after: input },
        summary: `Event ${input.event_id} accepted.`,
      };
    },
  }, callerHash);
}
