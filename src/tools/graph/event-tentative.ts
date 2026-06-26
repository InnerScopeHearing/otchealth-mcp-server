import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { tentativelyAcceptEvent } from '../../graph/full-client.js';

export function registerGraphEventTentative(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_event_tentative',
    category: 'write_simple',
    annotations: {
      title: 'Tentatively accept a calendar event invitation',
      description: 'Tentatively accept a calendar event invitation via POST /users/{sender}/events/{id}/tentativelyAccept. Sends a tentative response to the organizer. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      event_id: z.string().describe('The Graph event ID to tentatively accept.'),
      comment: z.string().optional().describe('Optional message to include with the tentative acceptance.'),
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
          summary: `DRY RUN: would tentatively accept event ${input.event_id}. Pass dry_run=false to apply.`,
        };
      }
      await tentativelyAcceptEvent(input.event_id, input.comment);
      return {
        data: { executed: true, dry_run: false, event_id: input.event_id },
        audit: { before: null, after: input },
        summary: `Event ${input.event_id} tentatively accepted.`,
      };
    },
  }, callerHash);
}
