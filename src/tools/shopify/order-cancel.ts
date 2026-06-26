import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelOrder } from '../../shopify/full-client.js';

export function registerShopifyOrderCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_order_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Cancel a Shopify order',
      description: 'Cancel an order via POST /orders/{id}/cancel.json. Irreversible — optionally triggers refund and restock. HIGH RISK: requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID to cancel.'),
      reason: z.enum(['customer', 'fraud', 'inventory', 'declined', 'other']).optional().describe('Cancellation reason.'),
      email: z.boolean().optional().default(true).describe('Whether to notify the customer by email (default true).'),
      restock: z.boolean().optional().default(true).describe('Whether to restock the items (default true).'),
      amount: z.string().optional().describe('Amount to refund as string, e.g. "29.99". Omit to use Shopify default.'),
      currency: z.string().optional().describe('3-letter currency code, e.g. "USD". Required if amount is provided.'),
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
          summary: `DRY RUN: would cancel order ${input.order_id} (reason: ${input.reason ?? 'not specified'}, restock: ${input.restock}, email: ${input.email}). Pass dry_run=false to apply.`,
        };
      }
      const { order_id, ...params } = input;
      const order = await cancelOrder(order_id, params, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, order },
        audit: { before: null, after: input },
        summary: `Order ${order_id} cancelled.`,
      };
    },
  }, callerHash);
}
