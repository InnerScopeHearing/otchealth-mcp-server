import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcCreateTicketType } from '../../intercom/full-client.js';

export function registerIntercomTicketTypeCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_type_create',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom ticket type',
      description: 'Create a new ticket type in Intercom via POST /ticket_types. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().describe('Ticket type name.'),
      description: z.string().optional().describe('Description of this ticket type.'),
      icon: z.string().optional().describe('Emoji icon for the ticket type (e.g. "🎟").'),
      is_internal: z.boolean().optional().describe('If true, this ticket type is for internal use only.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      ticket_type_id: z.string().nullable(),
      name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, ticket_type_id: null, name: input.name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create ticket type "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const resp = await fcCreateTicketType(input);
      return {
        data: { executed: true, dry_run: false, ticket_type_id: resp.id ?? null, name: resp.name ?? input.name },
        audit: { before: null, after: input },
        summary: `Ticket type "${resp.name ?? input.name}" created (id: ${resp.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
