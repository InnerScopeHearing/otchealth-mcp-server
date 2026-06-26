import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcCreateTicket } from '../../intercom/full-client.js';

export function registerIntercomTicketCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_create',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom ticket',
      description: 'Create a new ticket in Intercom via POST /tickets. Requires a ticket type and at least one contact. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      ticket_type_id: z.string().describe('Intercom ticket type ID for this ticket.'),
      contact_ids: z.array(z.string()).min(1).describe('Array of Intercom contact IDs to attach to this ticket.'),
      ticket_attributes: z.record(z.unknown()).optional().describe('Ticket attribute values keyed by attribute name.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      ticket_id: z.string().nullable(),
      ticket_type_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, ticket_id: null, ticket_type_id: input.ticket_type_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create ticket (type: ${input.ticket_type_id}) for ${input.contact_ids.length} contact(s). Pass dry_run=false to apply.`,
        };
      }
      const resp = await fcCreateTicket({
        ticket_type_id: input.ticket_type_id,
        contacts: input.contact_ids.map(id => ({ id })),
        ticket_attributes: input.ticket_attributes,
      });
      return {
        data: { executed: true, dry_run: false, ticket_id: resp.id ?? null, ticket_type_id: input.ticket_type_id },
        audit: { before: null, after: input },
        summary: `Ticket created (id: ${resp.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
