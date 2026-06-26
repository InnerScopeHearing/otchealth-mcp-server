import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateTicket } from '../../intercom/full-client.js';

export function registerIntercomTicketUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom ticket',
      description: 'Update a ticket\'s state, attributes, assignment, or snooze time via PUT /tickets/:id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      ticket_id: z.string().describe('Intercom ticket ID to update.'),
      state: z.enum(['submitted', 'in_progress', 'waiting_on_customer', 'resolved']).optional().describe('New ticket state.'),
      ticket_attributes: z.record(z.unknown()).optional().describe('Ticket attribute values to update.'),
      is_shared: z.boolean().optional().describe('Whether this ticket is shared with the contact (visible in their portal).'),
      snoozed_until: z.number().int().optional().describe('Unix timestamp (seconds) to snooze ticket until.'),
      assignee_admin_id: z.string().optional().describe('Intercom admin ID to assign the ticket to.'),
      assignee_team_id: z.string().optional().describe('Intercom team ID to assign the ticket to.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      ticket_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, ticket_id: input.ticket_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update ticket ${input.ticket_id}. Pass dry_run=false to apply.`,
        };
      }
      const { ticket_id, assignee_admin_id, assignee_team_id, ...rest } = input;
      await fcUpdateTicket({
        ticket_id,
        ...rest,
        assignment: (assignee_admin_id || assignee_team_id) ? {
          admin_id: assignee_admin_id,
          team_id: assignee_team_id,
        } : undefined,
      });
      return {
        data: { executed: true, dry_run: false, ticket_id: input.ticket_id },
        audit: { before: null, after: input },
        summary: `Ticket ${input.ticket_id} updated.`,
      };
    },
  }, callerHash);
}
