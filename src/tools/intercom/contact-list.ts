import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListContacts } from '../../intercom/full-client.js';

export function registerIntercomContactList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_list',
    category: 'read',
    annotations: {
      title: 'List Intercom contacts',
      description: 'Paginated list of all contacts (users and leads) in the Intercom workspace. Supports cursor-based pagination.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      per_page: z.number().int().min(1).max(150).optional().describe('Number of contacts per page (max 150).'),
      starting_after: z.string().optional().describe('Cursor for next page (from previous response pagination.next.starting_after).'),
      email: z.string().optional().describe('Filter contacts by email address.'),
    },
    outputShape: {
      contacts: z.array(z.unknown()),
      count: z.number(),
      total_count: z.number().nullable(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListContacts({
        per_page: input.per_page,
        starting_after: input.starting_after,
        email: input.email,
      });
      const contacts = resp.data ?? [];
      return {
        data: {
          contacts,
          count: contacts.length,
          total_count: resp.total_count ?? null,
          next_cursor: resp.pages?.next?.starting_after ?? null,
        },
        summary: `Found ${contacts.length} contact(s).`,
      };
    },
  }, callerHash);
}
