import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomer } from '../../shopify/full-client.js';

export function registerShopifyCustomerGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_customer_get',
    category: 'read',
    annotations: {
      title: 'Get a Shopify customer',
      description: 'Retrieve a single customer by ID via GET /customers/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.union([z.string(), z.number()]).describe('Shopify customer ID.'),
    },
    outputShape: {
      customer: z.unknown(),
    },
    handler: async (input, ctx) => {
      const customer = await getCustomer(input.customer_id, { correlationId: ctx.correlationId });
      return { data: { customer }, summary: `Retrieved customer ${input.customer_id}.` };
    },
  }, callerHash);
}
