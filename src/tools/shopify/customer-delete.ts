import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCustomer } from '../../shopify/full-client.js';

export function registerShopifyCustomerDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_customer_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Shopify customer',
      description: 'Permanently delete a customer record via DELETE /customers/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.union([z.string(), z.number()]).describe('Shopify customer ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_customer_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_customer_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete customer ${input.customer_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteCustomer(input.customer_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_customer_id: input.customer_id },
        audit: { before: null, after: input },
        summary: `Customer ${input.customer_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
