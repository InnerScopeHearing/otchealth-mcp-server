import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteOrder } from '../../shopify/full-client.js';

export function registerShopifyOrderDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_order_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Shopify order',
      description: 'Permanently delete a test/cancelled order via DELETE /orders/{id}.json. Only works on orders that have been cancelled first. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID to permanently delete. Must be cancelled first.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_order_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_order_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete order ${input.order_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteOrder(input.order_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_order_id: input.order_id },
        audit: { before: null, after: input },
        summary: `Order ${input.order_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
