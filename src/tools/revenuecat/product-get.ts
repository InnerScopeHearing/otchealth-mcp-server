import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProduct } from '../../revenuecat/full-client.js';

export function registerRevenueCatProductGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_product_get',
    category: 'read',
    annotations: {
      title: 'Get RevenueCat product',
      description: 'Fetch a single product by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      product_id: z.string().describe('Product ID'),
    },
    outputShape: { product: z.unknown() },
    handler: async (input) => {
      const product = await getProduct(input.project_id, input.product_id);
      return { data: { product }, summary: `Product: ${product?.store_identifier ?? input.product_id}` };
    },
  }, callerHash);
}
