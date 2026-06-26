import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProduct } from '../../stripe/full-client.js';

export function registerStripeProductUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_product_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Stripe product',
      description: 'Update product name, description, active status, or metadata. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Product ID (prod_...) to update.'),
      name: z.string().optional().describe('New product name.'),
      description: z.string().optional().describe('New description.'),
      active: z.boolean().optional().describe('Enable or disable the product.'),
      unit_label: z.string().optional().describe('Unit label (e.g. seat, item).'),
      url: z.string().url().optional().describe('Product URL.'),
      statement_descriptor: z.string().max(22).optional().describe('Statement descriptor.'),
      tax_code: z.string().optional().describe('Stripe tax code.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      product_id: z.string().nullable(),
      name: z.string().nullable(),
      active: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, product_id: input.product_id, name: null, active: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const { product_id, ...params } = input;
      const upstream = await updateProduct(product_id, params);
      return {
        data: { executed: true, dry_run: false, product_id: upstream.id, name: upstream.name, active: upstream.active },
        audit: { before: null, after: input },
        summary: `Updated product ${upstream.id} (${upstream.name}).`,
      };
    },
  }, callerHash);
}
