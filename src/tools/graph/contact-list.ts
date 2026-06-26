import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listContacts } from '../../graph/full-client.js';

export function registerGraphContactList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_contact_list',
    category: 'read',
    annotations: {
      title: 'List contacts',
      description: 'List contacts in the COO mailbox contacts folder via GET /users/{sender}/contacts. Supports filtering and pagination. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      top: z.number().int().min(1).max(100).optional().describe('Number of contacts to return (max 100, default 25).'),
      filter: z.string().optional().describe('OData $filter, e.g. "companyName eq \'Acme\'".'),
    },
    outputShape: {
      contacts: z.array(z.object({
        id: z.string(),
        display_name: z.string(),
        given_name: z.string(),
        surname: z.string(),
        email: z.string(),
        mobile_phone: z.string(),
        job_title: z.string(),
        company_name: z.string(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const contacts = await listContacts({
        top: input.top ?? 25,
        filter: input.filter,
        select: 'id,displayName,givenName,surname,emailAddresses,mobilePhone,jobTitle,companyName',
      });
      const mapped = contacts.map((c: any) => ({
        id: c.id ?? '',
        display_name: c.displayName ?? '',
        given_name: c.givenName ?? '',
        surname: c.surname ?? '',
        email: c.emailAddresses?.[0]?.address ?? '',
        mobile_phone: c.mobilePhone ?? '',
        job_title: c.jobTitle ?? '',
        company_name: c.companyName ?? '',
      }));
      return {
        data: { contacts: mapped, count: mapped.length },
        summary: `Found ${mapped.length} contact(s).`,
      };
    },
  }, callerHash);
}
