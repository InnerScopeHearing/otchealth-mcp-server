import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProducts } from '../../revenuecat/full-client.js';

export function registerRevenueCatProductList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_product_list',
    category: 'read',
    annotations: {
      title: 'List RevenueCat products',
      description: 'List all products in a project, optionally filtered by app.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      app_id: z.string().optional().describe('Filter to a specific app ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size'),
    },
    outputShape: { products: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await listProducts(input.project_id, { app_id: input.app_id, starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.products ?? [];
      return { data: { products: items, count: items.length }, summary: `${items.length} product(s).` };
    },
  }, callerHash);
}
