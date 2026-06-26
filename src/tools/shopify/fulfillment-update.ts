import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateFulfillment } from '../../shopify/full-client.js';

export function registerShopifyFulfillmentUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_fulfillment_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a fulfillment',
      description: 'Update tracking information on an existing fulfillment via PUT /orders/{id}/fulfillments/{fulfillment_id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID.'),
      fulfillment_id: z.union([z.string(), z.number()]).describe('Shopify fulfillment ID to update.'),
      tracking_number: z.string().optional().describe('Shipment tracking number.'),
      tracking_company: z.string().optional().describe('Shipping carrier name, e.g. "UPS", "FedEx".'),
      tracking_url: z.string().url().optional().describe('Tracking URL.'),
      notify_customer: z.boolean().optional().describe('Whether to notify the customer of the update.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      fulfillment: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, fulfillment: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update fulfillment ${input.fulfillment_id} for order ${input.order_id}. Pass dry_run=false to apply.`,
        };
      }
      const { order_id, fulfillment_id, ...patch } = input;
      const fulfillment = await updateFulfillment(order_id, fulfillment_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, fulfillment },
        audit: { before: null, after: input },
        summary: `Fulfillment ${fulfillment_id} for order ${order_id} updated.`,
      };
    },
  }, callerHash);
}
