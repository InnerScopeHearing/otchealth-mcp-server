import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcSearchContacts } from '../../intercom/full-client.js';

export function registerIntercomContactSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_search',
    category: 'read',
    annotations: {
      title: 'Search Intercom contacts',
      description: 'Search contacts using Intercom\'s query DSL via POST /contacts/search. Supports field/operator/value queries with AND/OR combinators.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      field: z.string().optional().describe('Contact field to filter on (e.g. "email", "name", "role", "created_at"). Use this for a single-field query.'),
      operator: z.string().optional().describe('Comparison operator: "=", "!=", "IN", "NIN", ">", "<", "~", "!~", "^", "$".'),
      value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Value to match against.'),
      combine_operator: z.enum(['AND', 'OR']).optional().describe('Combine multiple field conditions with AND or OR.'),
      conditions: z.array(z.object({
        field: z.string().describe('Contact field.'),
        operator: z.string().describe('Comparison operator.'),
        value: z.union([z.string(), z.number(), z.boolean()]).describe('Match value.'),
      })).optional().describe('Array of conditions when using combine_operator.'),
      per_page: z.number().int().min(1).max(150).optional().describe('Results per page.'),
      starting_after: z.string().optional().describe('Pagination cursor.'),
    },
    outputShape: {
      contacts: z.array(z.unknown()),
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
      const resp = await fcSearchContacts({
        query,
        per_page: input.per_page,
        starting_after: input.starting_after,
      });
      const contacts = resp.data ?? [];
      return {
        data: {
          contacts,
          count: contacts.length,
          total_count: resp.total_count ?? null,
          next_cursor: resp.pages?.next?.starting_after ?? null,
        },
        summary: `Found ${contacts.length} matching contact(s).`,
      };
    },
  }, callerHash);
}
