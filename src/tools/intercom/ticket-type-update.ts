import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateTicketType } from '../../intercom/full-client.js';

export function registerIntercomTicketTypeUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_type_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom ticket type',
      description: 'Update an existing ticket type via PUT /ticket_types/:id. Can also archive a ticket type. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      ticket_type_id: z.string().describe('Intercom ticket type ID.'),
      name: z.string().optional().describe('New ticket type name.'),
      description: z.string().optional().describe('New description.'),
      icon: z.string().optional().describe('New emoji icon.'),
      archived: z.boolean().optional().describe('Set to true to archive this ticket type.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      ticket_type_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, ticket_type_id: input.ticket_type_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update ticket type ${input.ticket_type_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUpdateTicketType(input);
      return {
        data: { executed: true, dry_run: false, ticket_type_id: input.ticket_type_id },
        audit: { before: null, after: input },
        summary: `Ticket type ${input.ticket_type_id} updated.`,
      };
    },
  }, callerHash);
}
