import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createContact } from '../../graph/full-client.js';

export function registerGraphContactCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_contact_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a contact',
      description: 'Create a new contact in the COO mailbox contacts folder via POST /users/{sender}/contacts. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      given_name: z.string().describe('Contact first name.'),
      surname: z.string().optional().describe('Contact last name.'),
      email: z.string().optional().describe('Primary email address.'),
      mobile_phone: z.string().optional().describe('Mobile phone number.'),
      business_phone: z.string().optional().describe('Primary business phone number.'),
      job_title: z.string().optional().describe('Job title.'),
      company_name: z.string().optional().describe('Company or organization name.'),
      department: z.string().optional().describe('Department within the company.'),
      office_location: z.string().optional().describe('Office location.'),
      personal_notes: z.string().optional().describe('Free-text notes.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string().nullable(),
      display_name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            contact_id: null,
            display_name: `${input.given_name} ${input.surname ?? ''}`.trim(),
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create contact "${input.given_name} ${input.surname ?? ''}". Pass dry_run=false to apply.`,
        };
      }
      const contact = await createContact({
        givenName: input.given_name,
        surname: input.surname,
        emailAddresses: input.email ? [{ address: input.email }] : undefined,
        mobilePhone: input.mobile_phone,
        businessPhones: input.business_phone ? [input.business_phone] : undefined,
        jobTitle: input.job_title,
        companyName: input.company_name,
        department: input.department,
        officeLocation: input.office_location,
        personalNotes: input.personal_notes,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          contact_id: contact.id ?? null,
          display_name: contact.displayName ?? `${input.given_name} ${input.surname ?? ''}`.trim(),
        },
        audit: { before: null, after: input },
        summary: `Contact "${contact.displayName}" created (id: ${contact.id}).`,
      };
    },
  }, callerHash);
}
