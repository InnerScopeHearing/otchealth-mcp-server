import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcDetachContactFromCompany } from '../../intercom/full-client.js';

export function registerIntercomCompanyDetachContact(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_detach_contact',
    category: 'write_simple',
    annotations: {
      title: 'Detach a contact from an Intercom company',
      description: 'Remove a contact\'s association with a company via DELETE /contacts/:contact_id/companies/:company_id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID.'),
      company_id: z.string().describe('Intercom company ID to detach.'),
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
          summary: `DRY RUN: would detach contact ${input.contact_id} from company ${input.company_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcDetachContactFromCompany({ contact_id: input.contact_id, company_id: input.company_id });
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id, company_id: input.company_id },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} detached from company ${input.company_id}.`,
      };
    },
  }, callerHash);
}
