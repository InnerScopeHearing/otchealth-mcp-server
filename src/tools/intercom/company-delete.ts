import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcDeleteCompany } from '../../intercom/full-client.js';

export function registerIntercomCompanyDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete an Intercom company (irreversible)',
      description: 'Permanently delete a company from Intercom via DELETE /companies/:id. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      company_id: z.string().describe('Intercom company ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      company_id: z.string(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, company_id: input.company_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete company ${input.company_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcDeleteCompany(input.company_id);
      return {
        data: { executed: true, dry_run: false, company_id: input.company_id, deleted: true },
        audit: { before: null, after: input },
        summary: `Company ${input.company_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
