import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcSearchTickets } from '../../intercom/full-client.js';

export function registerIntercomTicketSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_search',
    category: 'read',
    annotations: {
      title: 'Search Intercom tickets',
      description: 'Search tickets using Intercom\'s query DSL via POST /tickets/search. Supports field/operator/value queries with AND/OR combinators.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      field: z.string().optional().describe('Ticket field to filter on (e.g. "state", "ticket_type_id").'),
      operator: z.string().optional().describe('Comparison operator: "=", "!=", "IN", "NIN", ">", "<".'),
      value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Value to match against.'),
      combine_operator: z.enum(['AND', 'OR']).optional().describe('Combine multiple conditions.'),
      conditions: z.array(z.object({
        field: z.string(),
        operator: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })).optional().describe('Array of conditions when using combine_operator.'),
      per_page: z.number().int().min(1).max(150).optional().describe('Results per page.'),
      starting_after: z.string().optional().describe('Pagination cursor.'),
    },
    outputShape: {
      tickets: z.array(z.unknown()),
      count: z.number(),
      total_count: z.number().nullable(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      let query: any;
      if (input.combine_operator && input.conditions) {
        query = { operator: input.combine_operator, value: input.conditions };
      } else {
        query = { field: input.field, operator: input.operator, value: input.value };
      }
      const resp = await fcSearchTickets({
        query,
        per_page: input.per_page,
        starting_after: input.starting_after,
      });
      const tickets = resp.data ?? resp.tickets ?? [];
      return {
        data: {
          tickets,
          count: tickets.length,
          total_count: resp.total_count ?? null,
          next_cursor: resp.pages?.next?.starting_after ?? null,
        },
        summary: `Found ${tickets.length} matching ticket(s).`,
      };
    },
  }, callerHash);
}
