import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { calculateRefund } from '../../shopify/full-client.js';

export function registerShopifyRefundCalculate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_refund_calculate',
    category: 'read',
    annotations: {
      title: 'Calculate a refund',
      description: 'Calculate refund amounts for line items and shipping without creating a refund via POST /orders/{id}/refunds/calculate.json. Use this before shopify_refund_create to confirm amounts.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID to calculate refund for.'),
      shipping_full_refund: z.boolean().optional().describe('Whether to fully refund shipping.'),
      shipping_amount: z.string().optional().describe('Specific shipping amount to refund, e.g. "5.00".'),
      currency: z.string().optional().describe('3-letter currency code, e.g. "USD".'),
      refund_line_items: z.array(z.object({
        line_item_id: z.number().int().describe('ID of the line item to refund.'),
        quantity: z.number().int().min(1).describe('Quantity to refund.'),
        restock_type: z.enum(['no_restock', 'cancel', 'return', 'legacy_restock']).optional().describe('How to handle inventory.'),
      })).optional().describe('Line items to refund.'),
    },
    outputShape: {
      refund: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { order_id, shipping_full_refund, shipping_amount, currency, refund_line_items } = input;
      const refund = await calculateRefund(order_id, {
        currency,
        shipping: shipping_full_refund !== undefined || shipping_amount !== undefined
          ? { full_refund: shipping_full_refund, amount: shipping_amount }
          : undefined,
        refund_line_items,
      }, { correlationId: ctx.correlationId });
      return { data: { refund }, summary: `Refund calculated for order ${order_id}.` };
    },
  }, callerHash);
}
