import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelFulfillment } from '../../shopify/full-client.js';

export function registerShopifyFulfillmentCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_fulfillment_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Cancel a fulfillment',
      description: 'Cancel an existing fulfillment via POST /orders/{id}/fulfillments/{fulfillment_id}/cancel.json. Irreversible. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID.'),
      fulfillment_id: z.union([z.string(), z.number()]).describe('Shopify fulfillment ID to cancel.'),
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
          summary: `DRY RUN: would cancel fulfillment ${input.fulfillment_id} for order ${input.order_id}. Pass dry_run=false to apply.`,
        };
      }
      const fulfillment = await cancelFulfillment(input.order_id, input.fulfillment_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, fulfillment },
        audit: { before: null, after: input },
        summary: `Fulfillment ${input.fulfillment_id} for order ${input.order_id} cancelled.`,
      };
    },
  }, callerHash);
}
