import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListContactAttachedCompanies } from '../../intercom/full-client.js';

export function registerIntercomContactListCompanies(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_list_companies',
    category: 'read',
    annotations: {
      title: 'List companies attached to an Intercom contact',
      description: 'Retrieve the companies associated with a specific contact via GET /contacts/:id/companies.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID.'),
    },
    outputShape: {
      companies: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListContactAttachedCompanies(input.contact_id);
      const companies = resp.data ?? resp.companies ?? [];
      return {
        data: { companies, count: companies.length },
        summary: `Contact ${input.contact_id} is attached to ${companies.length} company/companies.`,
      };
    },
  }, callerHash);
}
