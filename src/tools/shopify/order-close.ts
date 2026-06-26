import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { closeOrder } from '../../shopify/full-client.js';

export function registerShopifyOrderClose(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_order_close',
    category: 'write_simple',
    annotations: {
      title: 'Close a Shopify order',
      description: 'Close an open order via POST /orders/{id}/close.json. Prevents further fulfillment or payment activity. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID to close.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      order: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, order: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would close order ${input.order_id}. Pass dry_run=false to apply.`,
        };
      }
      const order = await closeOrder(input.order_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, order },
        audit: { before: null, after: input },
        summary: `Order ${input.order_id} closed.`,
      };
    },
  }, callerHash);
}
