import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateContact } from '../../graph/full-client.js';

export function registerGraphContactUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_contact_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a contact',
      description: 'Update fields on an existing contact via PATCH /users/{sender}/contacts/{id}. Only provided fields are changed. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('The Graph contact ID to update.'),
      given_name: z.string().optional().describe('Updated first name.'),
      surname: z.string().optional().describe('Updated last name.'),
      email: z.string().optional().describe('Updated primary email address.'),
      mobile_phone: z.string().optional().describe('Updated mobile phone.'),
      business_phone: z.string().optional().describe('Updated primary business phone.'),
      job_title: z.string().optional().describe('Updated job title.'),
      company_name: z.string().optional().describe('Updated company name.'),
      department: z.string().optional().describe('Updated department.'),
      office_location: z.string().optional().describe('Updated office location.'),
      personal_notes: z.string().optional().describe('Updated free-text notes.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: input.contact_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update contact ${input.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await updateContact({
        contactId: input.contact_id,
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
        data: { executed: true, dry_run: false, contact_id: input.contact_id },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} updated.`,
      };
    },
  }, callerHash);
}
