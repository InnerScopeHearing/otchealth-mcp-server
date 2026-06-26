import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fulfillOrder } from '../../shopify/write-client.js';

export function registerShopifyFulfillOrder(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_fulfill_order',
      category: 'write_orchestrated', // triggers shipping + customer-facing notification
      annotations: {
        title: 'Create a fulfillment for a Shopify order',
        description:
          'Create a fulfillment record for an order via POST /orders/{id}/fulfillments.json. ' +
          'This marks items as shipped, optionally attaches a tracking number, and (when notify_customer=true) ' +
          'sends a Shopify shipping confirmation email to the customer. ' +
          'Requires ENABLE_HIGH_RISK_TOOLS=true. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        order_id: z
          .union([z.string(), z.number()])
          .describe('Shopify order ID to fulfil.'),
        location_id: z
          .number()
          .int()
          .positive()
          .describe(
            'Location ID from which items are shipped. Find via Admin > Locations or GET /locations.json.',
          ),
        tracking_number: z.string().optional().describe('Carrier tracking number.'),
        tracking_company: z
          .string()
          .optional()
          .describe(
            'Carrier name, e.g. "UPS", "USPS", "FedEx". Shopify uses this to generate a tracking URL.',
          ),
        tracking_url: z.string().url().optional().describe('Direct tracking URL (overrides auto-generated URL).'),
        notify_customer: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Whether to send a Shopify shipping confirmation email. Defaults to true.',
          ),
        line_items_by_fulfillment_order: z
          .array(
            z.object({
              fulfillment_order_id: z
                .number()
                .int()
                .positive()
                .describe('Fulfillment order ID (from GET /orders/{id}/fulfillment_orders.json).'),
              fulfillment_order_line_items: z
                .array(
                  z.object({
                    id: z.number().int().positive().describe('Fulfillment order line item ID.'),
                    quantity: z.number().int().positive(),
                  }),
                )
                .optional()
                .describe('Omit to fulfil all items in the fulfillment order.'),
            }),
          )
          .optional()
          .describe(
            'Fulfillment-order-based payload for partial fulfillments. ' +
              'When omitted, all unfulfilled line items in the order are fulfilled.',
          ),
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
            summary:
              `DRY RUN: would create fulfillment for order ${input.order_id} ` +
              `from location ${input.location_id}` +
              (input.tracking_number ? ` with tracking ${input.tracking_number}` : '') +
              `. notify_customer=${input.notify_customer ?? true}. Pass dry_run=false to apply.`,
          };
        }

        const fulfillment = await fulfillOrder(
          input.order_id,
          {
            location_id: input.location_id,
            tracking_number: input.tracking_number,
            tracking_company: input.tracking_company,
            tracking_url: input.tracking_url,
            notify_customer: input.notify_customer,
            line_items_by_fulfillment_order: input.line_items_by_fulfillment_order,
          },
          { correlationId: ctx.correlationId },
        );

        return {
          data: { executed: true, dry_run: false, fulfillment },
          audit: { before: null, after: input },
          summary: `Fulfillment created for order ${input.order_id}.`,
        };
      },
    },
    callerHash,
  );
}
