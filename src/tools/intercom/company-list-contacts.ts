import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListCompanyAttachedContacts } from '../../intercom/full-client.js';

export function registerIntercomCompanyListContacts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_list_contacts',
    category: 'read',
    annotations: {
      title: 'List contacts attached to an Intercom company',
      description: 'Retrieve all contacts associated with a specific Intercom company via GET /companies/:id/contacts.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      company_id: z.string().describe('Intercom company ID.'),
      per_page: z.number().int().min(1).max(150).optional().describe('Contacts per page.'),
      starting_after: z.string().optional().describe('Pagination cursor.'),
    },
    outputShape: {
      contacts: z.array(z.unknown()),
      count: z.number(),
      total_count: z.number().nullable(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListCompanyAttachedContacts({
        company_id: input.company_id,
        per_page: input.per_page,
        starting_after: input.starting_after,
      });
      const contacts = resp.data ?? resp.contacts ?? [];
      return {
        data: { contacts, count: contacts.length, total_count: resp.total_count ?? null },
        summary: `Company ${input.company_id} has ${contacts.length} contact(s).`,
      };
    },
  }, callerHash);
}
