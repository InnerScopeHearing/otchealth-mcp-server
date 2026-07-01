import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listDraftOrders } from '../../shopify/full-client.js';

export function registerShopifyDraftOrderList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_draft_order_list',
    category: 'read',
    annotations: {
      title: 'List draft orders',
      description: 'Retrieve a paginated list of draft orders via GET /draft_orders.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
      status: z.enum(['open', 'invoice_sent', 'completed']).optional().describe('Draft order status filter.'),
      ids: z.string().optional().describe('Comma-separated draft order IDs.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
      updated_at_min: z.string().optional().describe('ISO 8601 min updated date.'),
      updated_at_max: z.string().optional().describe('ISO 8601 max updated date.'),
    },
    outputShape: {
      draft_orders: z.unknown(),
    },
    handler: async (input, ctx) => {
      const draft_orders = await listDraftOrders(input as any, { correlationId: ctx.correlationId });
      return { data: { draft_orders }, summary: `Listed draft orders.` };
    },
  }, callerHash);
}
