import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomerAttributes } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerGetAttributes(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_get_attributes',
    category: 'read',
    annotations: {
      title: 'Get customer attributes',
      description: 'Fetch subscriber attributes for a customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      customer_id: z.string().describe('Customer ID'),
    },
    outputShape: { attributes: z.unknown() },
    handler: async (input) => {
      const attributes = await getCustomerAttributes(input.project_id, input.customer_id);
      return { data: { attributes }, summary: `Attributes for customer ${input.customer_id}.` };
    },
  }, callerHash);
}
