import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDraftOrder } from '../../shopify/full-client.js';

export function registerShopifyDraftOrderGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_draft_order_get',
    category: 'read',
    annotations: {
      title: 'Get a draft order',
      description: 'Retrieve a single draft order by ID via GET /draft_orders/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      draft_order_id: z.union([z.string(), z.number()]).describe('Shopify draft order ID.'),
    },
    outputShape: {
      draft_order: z.unknown(),
    },
    handler: async (input, ctx) => {
      const draft_order = await getDraftOrder(input.draft_order_id, { correlationId: ctx.correlationId });
      return { data: { draft_order }, summary: `Retrieved draft order ${input.draft_order_id}.` };
    },
  }, callerHash);
}
