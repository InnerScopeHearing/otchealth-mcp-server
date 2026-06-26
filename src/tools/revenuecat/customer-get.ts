import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomer } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_get',
    category: 'read',
    annotations: {
      title: 'Get RevenueCat customer',
      description: 'Fetch a single customer (subscriber) record by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      customer_id: z.string().describe('Customer / subscriber ID (app_user_id)'),
    },
    outputShape: { customer: z.unknown() },
    handler: async (input) => {
      const customer = await getCustomer(input.project_id, input.customer_id);
      return { data: { customer }, summary: `Customer: ${input.customer_id}` };
    },
  }, callerHash);
}
