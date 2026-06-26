import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProduct } from '../../revenuecat/full-client.js';

export function registerRevenueCatProductUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_product_update',
    category: 'write_simple',
    annotations: {
      title: 'Update RevenueCat product',
      description: 'Update a product (display name etc). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      product_id: z.string().describe('Product ID'),
      display_name: z.string().optional().describe('New display name'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), product: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, product: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const product = await updateProduct(input.project_id, input.product_id, { display_name: input.display_name });
      return {
        data: { executed: true, dry_run: false, product },
        audit: { before: null, after: input },
        summary: `Product ${input.product_id} updated.`,
      };
    },
  }, callerHash);
}
