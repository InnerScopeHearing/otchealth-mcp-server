import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createVariant } from '../../gumroad/full-client.js';

export function registerGumroadVariantCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_variant_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Gumroad variant',
      description: 'Create a new variant (e.g. "Large") inside a variant category on a Gumroad product. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      variant_category_id: z.string().describe('Variant category ID to add the variant to.'),
      name: z.string().describe('Name of the variant (e.g. "Large", "Red").'),
      price_difference_cents: z.number().int().optional().describe('Price difference from base product price, in cents. Negative for discount.'),
      max_purchase_count: z.number().int().optional().describe('Maximum number of times this variant can be purchased (stock limit). Omit for unlimited.'),
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
          summary: `DRY RUN: would create variant "${input.name}" in category ${input.variant_category_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await createVariant(input.product_id, input.variant_category_id, {
        name: input.name,
        price_difference_cents: input.price_difference_cents,
        max_purchase_count: input.max_purchase_count,
      });
      return {
        data: { executed: true, dry_run: false, variant: resp.variant ?? resp },
        audit: { before: null, after: input },
        summary: `Created variant "${input.name}" in category ${input.variant_category_id}.`,
      };
    },
  }, callerHash);
}
