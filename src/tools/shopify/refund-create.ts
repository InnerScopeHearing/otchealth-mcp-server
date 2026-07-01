import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createRefund } from '../../shopify/full-client.js';

export function registerShopifyRefundCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_refund_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create a refund',
      description: 'Issue a refund on an order via POST /orders/{id}/refunds.json. MONEY MOVEMENT — irreversible. Run shopify_refund_calculate first. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID to refund.'),
      currency: z.string().optional().describe('3-letter currency code, e.g. "USD".'),
      notify: z.boolean().optional().default(true).describe('Whether to notify the customer of the refund.'),
      note: z.string().optional().describe('Staff-facing note about this refund.'),
      shipping_full_refund: z.boolean().optional().describe('Whether to fully refund shipping.'),
      shipping_amount: z.string().optional().describe('Specific shipping amount to refund.'),
      refund_line_items: z.array(z.object({
        line_item_id: z.number().int().describe('Line item ID to refund.'),
        quantity: z.number().int().min(1).describe('Quantity to refund.'),
        restock_type: z.enum(['no_restock', 'cancel', 'return', 'legacy_restock']).optional().describe('Inventory handling.'),
        location_id: z.number().int().optional().describe('Location ID for restocking (required if restock_type is "return").'),
      })).optional().describe('Line items to refund.'),
      transactions: z.array(z.object({
        parent_id: z.number().int().describe('Parent transaction ID.'),
        amount: z.string().describe('Amount to refund, e.g. "29.99".'),
        kind: z.enum(['refund']).describe('Transaction kind (always "refund").'),
        gateway: z.string().optional().describe('Payment gateway.'),
      })).optional().describe('Transactions for the refund. Required for actual money movement.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      refund: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, refund: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create refund for order ${input.order_id}. Run shopify_refund_calculate first to confirm amounts. Pass dry_run=false to apply.`,
        };
      }
      const { order_id, shipping_full_refund, shipping_amount, ...rest } = input;
      const refund = await createRefund(order_id, {
        ...rest,
        shipping: shipping_full_refund !== undefined || shipping_amount !== undefined
          ? { full_refund: shipping_full_refund, amount: shipping_amount }
          : undefined,
      }, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, refund },
        audit: { before: null, after: input },
        summary: `Refund created for order ${order_id}.`,
      };
    },
  }, callerHash);
}
