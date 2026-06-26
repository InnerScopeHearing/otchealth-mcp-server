import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCustomer } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete RevenueCat customer',
      description: 'Permanently delete a customer and all their data. IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      customer_id: z.string().describe('Customer ID to permanently delete'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), deleted_id: z.string().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_id: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete customer ${input.customer_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteCustomer(input.project_id, input.customer_id);
      return {
        data: { executed: true, dry_run: false, deleted_id: input.customer_id },
        audit: { before: null, after: input },
        summary: `Customer ${input.customer_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
