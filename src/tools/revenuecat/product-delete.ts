import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProduct } from '../../revenuecat/full-client.js';

export function registerRevenueCatProductDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_product_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete RevenueCat product',
      description: 'Permanently delete a product. IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      product_id: z.string().describe('Product ID to delete'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), deleted_id: z.string().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_id: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteProduct(input.project_id, input.product_id);
      return {
        data: { executed: true, dry_run: false, deleted_id: input.product_id },
        audit: { before: null, after: input },
        summary: `Product ${input.product_id} deleted.`,
      };
    },
  }, callerHash);
}
