import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomerSubscriptions } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerGetSubscriptions(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_get_subscriptions',
    category: 'read',
    annotations: {
      title: 'Get customer subscriptions',
      description: 'List all subscriptions for a customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      customer_id: z.string().describe('Customer ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size'),
    },
    outputShape: { subscriptions: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await getCustomerSubscriptions(input.project_id, input.customer_id, { starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.subscriptions ?? [];
      return { data: { subscriptions: items, count: items.length }, summary: `${items.length} subscription(s) for ${input.customer_id}.` };
    },
  }, callerHash);
}
