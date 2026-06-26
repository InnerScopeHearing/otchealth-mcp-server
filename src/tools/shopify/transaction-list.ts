import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTransactions } from '../../shopify/full-client.js';

export function registerShopifyTransactionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_transaction_list',
    category: 'read',
    annotations: {
      title: 'List transactions for an order',
      description: 'Retrieve all payment transactions for a specific order via GET /orders/{id}/transactions.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID.'),
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
      since_id: z.number().int().optional().describe('Return transactions after this ID.'),
    },
    outputShape: {
      transactions: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { order_id, ...params } = input;
      const transactions = await listTransactions(order_id, params, { correlationId: ctx.correlationId });
      return { data: { transactions }, summary: `Listed transactions for order ${order_id}.` };
    },
  }, callerHash);
}
