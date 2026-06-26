import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateVariant } from '../../gumroad/full-client.js';

export function registerGumroadVariantUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_variant_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Gumroad variant',
      description: 'Update name, price difference, or stock limit on an existing Gumroad variant. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      variant_category_id: z.string().describe('Variant category ID.'),
      variant_id: z.string().describe('Variant ID to update.'),
      name: z.string().optional().describe('New name for the variant.'),
      price_difference_cents: z.number().int().optional().describe('New price difference in cents from base price.'),
      max_purchase_count: z.number().int().optional().describe('New stock limit; omit to leave unchanged.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      variant: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update variant ${input.variant_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await updateVariant(input.product_id, input.variant_category_id, input.variant_id, {
        name: input.name,
        price_difference_cents: input.price_difference_cents,
        max_purchase_count: input.max_purchase_count,
      });
      return {
        data: { executed: true, dry_run: false, variant: resp.variant ?? resp },
        audit: { before: null, after: input },
        summary: `Updated variant ${input.variant_id}.`,
      };
    },
  }, callerHash);
}
