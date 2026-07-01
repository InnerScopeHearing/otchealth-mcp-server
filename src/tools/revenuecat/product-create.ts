import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProduct } from '../../revenuecat/full-client.js';

export function registerRevenueCatProductCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_product_create',
    category: 'write_simple',
    annotations: {
      title: 'Create RevenueCat product',
      description: 'Register a store product (SKU) in RevenueCat. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      store_identifier: z.string().describe('Product identifier in the store (e.g. com.app.monthly)'),
      app_id: z.string().describe('App ID this product belongs to'),
      type: z.enum(['subscription', 'non_subscription', 'one_time']).optional().describe('Product type'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), product: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, product: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create product "${input.store_identifier}" in app ${input.app_id}. Pass dry_run=false to apply.`,
        };
      }
      const product = await createProduct(input.project_id, { store_identifier: input.store_identifier, app_id: input.app_id, type: input.type });
      return {
        data: { executed: true, dry_run: false, product },
        audit: { before: null, after: input },
        summary: `Product "${input.store_identifier}" created.`,
      };
    },
  }, callerHash);
}
