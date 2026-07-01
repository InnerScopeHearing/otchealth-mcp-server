import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateOrder } from '../../shopify/write-client.js';

/**
 * Fields that operators must NOT patch via this tool. Financial and fulfilment
 * fields are managed through dedicated Shopify flows; allowing arbitrary patches
 * here would risk incorrect charge/refund states.
 */
const PROTECTED_ORDER_FIELDS = new Set([
  'line_items',
  'total_price',
  'subtotal_price',
  'financial_status',
  'fulfillment_status',
  'customer',
  'billing_address',
  'shipping_address',
]);

export function registerShopifyUpdateOrder(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_update_order',
      category: 'write_simple',
      annotations: {
        title: 'Update Shopify order tags / note / email',
        description:
          'Patch non-financial, non-fulfilment fields on an existing order via PUT /orders/{id}.json. ' +
          'Supports: tags (full replacement), note (staff memo), and email (contact email). ' +
          'Financial and fulfilment fields are rejected. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        order_id: z
          .union([z.string(), z.number()])
          .describe('Shopify order ID to update.'),
        tags: z
          .string()
          .optional()
          .describe(
            'Comma-separated full tag string. REPLACES existing tags entirely — include all desired tags. ' +
              'E.g. "wholesale,priority,q2-campaign".',
          ),
        note: z
          .string()
          .optional()
          .describe(
            'Staff-facing order note. Replaces any existing note. ' +
              'Visible in Admin > Orders > order detail.',
          ),
        email: z
          .string()
          .email()
          .optional()
          .describe(
            'Contact email address for the order. Changes where Shopify sends order-status emails.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        order: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        const { order_id, ...patch } = input;

        // Safety: refuse if caller somehow passes protected fields (belt-and-suspenders
        // since Zod's strict inputShape already blocks unknown keys, but being explicit
        // about intent protects against future schema drift).
        const offending = Object.keys(patch).filter((k) => PROTECTED_ORDER_FIELDS.has(k));
        if (offending.length > 0) {
          throw new Error(
            `Cannot patch protected order fields via this tool: ${offending.join(', ')}. ` +
              'Use dedicated Shopify Admin flows for financial/fulfilment changes.',
          );
        }

        if (Object.keys(patch).length === 0) {
          throw new Error(
            'No patchable fields provided. Supply at least one of: tags, note, email.',
          );
        }

        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, order: null },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would update order ${order_id} — fields: ${Object.keys(patch).join(', ')}. ` +
              'Pass dry_run=false to apply.',
          };
        }

        const order = await updateOrder(order_id, patch, { correlationId: ctx.correlationId });

        return {
          data: { executed: true, dry_run: false, order },
          audit: { before: null, after: input },
          summary: `Order ${order_id} updated (${Object.keys(patch).join(', ')}).`,
        };
      },
    },
    callerHash,
  );
}
