import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getContact } from '../../graph/full-client.js';

export function registerGraphContactGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_contact_get',
    category: 'read',
    annotations: {
      title: 'Get a single contact',
      description: 'Retrieve the full details of a contact by ID via GET /users/{sender}/contacts/{id}. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('The Graph contact ID to retrieve.'),
    },
    outputShape: {
      id: z.string(),
      display_name: z.string(),
      given_name: z.string(),
      surname: z.string(),
      emails: z.array(z.string()),
      mobile_phone: z.string(),
      business_phones: z.array(z.string()),
      job_title: z.string(),
      company_name: z.string(),
      department: z.string(),
      office_location: z.string(),
      personal_notes: z.string(),
    },
    handler: async (input, _ctx) => {
      const c = await getContact(input.contact_id);
      return {
        data: {
          id: c.id ?? '',
          display_name: c.displayName ?? '',
          given_name: c.givenName ?? '',
          surname: c.surname ?? '',
          emails: (c.emailAddresses ?? []).map((e: any) => e.address ?? ''),
          mobile_phone: c.mobilePhone ?? '',
          business_phones: c.businessPhones ?? [],
          job_title: c.jobTitle ?? '',
          company_name: c.companyName ?? '',
          department: c.department ?? '',
          office_location: c.officeLocation ?? '',
          personal_notes: c.personalNotes ?? '',
        },
        summary: `Retrieved contact "${c.displayName}".`,
      };
    },
  }, callerHash);
}
