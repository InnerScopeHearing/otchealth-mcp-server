import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCustomers } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_list',
    category: 'read',
    annotations: {
      title: 'List RevenueCat customers',
      description: 'List customers (subscribers) in a project with pagination.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100)'),
    },
    outputShape: { customers: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await listCustomers(input.project_id, { starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.customers ?? [];
      return { data: { customers: items, count: items.length }, summary: `${items.length} customer(s).` };
    },
  }, callerHash);
}
