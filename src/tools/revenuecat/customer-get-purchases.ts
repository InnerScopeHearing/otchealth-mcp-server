import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomerPurchases } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerGetPurchases(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_get_purchases',
    category: 'read',
    annotations: {
      title: 'Get customer purchases',
      description: 'List all one-time purchases for a customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      customer_id: z.string().describe('Customer ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size'),
    },
    outputShape: { purchases: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await getCustomerPurchases(input.project_id, input.customer_id, { starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.purchases ?? [];
      return { data: { purchases: items, count: items.length }, summary: `${items.length} purchase(s) for ${input.customer_id}.` };
    },
  }, callerHash);
}
