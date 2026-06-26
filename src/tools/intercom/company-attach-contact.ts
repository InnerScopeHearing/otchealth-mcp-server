import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcAttachContactToCompany } from '../../intercom/full-client.js';

export function registerIntercomCompanyAttachContact(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_attach_contact',
    category: 'write_simple',
    annotations: {
      title: 'Attach a contact to an Intercom company',
      description: 'Associate a contact with a company via POST /contacts/:contact_id/companies. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID.'),
      company_id: z.string().describe('Intercom company ID to attach the contact to.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
      company_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: input.contact_id, company_id: input.company_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would attach contact ${input.contact_id} to company ${input.company_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcAttachContactToCompany({ contact_id: input.contact_id, company_id: input.company_id });
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id, company_id: input.company_id },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} attached to company ${input.company_id}.`,
      };
    },
  }, callerHash);
}
