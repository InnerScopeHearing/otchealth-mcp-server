import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getTransaction } from '../../shopify/full-client.js';

export function registerShopifyTransactionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_transaction_get',
    category: 'read',
    annotations: {
      title: 'Get a transaction',
      description: 'Retrieve a single payment transaction by order and transaction ID via GET /orders/{id}/transactions/{transaction_id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID.'),
      transaction_id: z.union([z.string(), z.number()]).describe('Shopify transaction ID.'),
    },
    outputShape: {
      transaction: z.unknown(),
    },
    handler: async (input, ctx) => {
      const transaction = await getTransaction(input.order_id, input.transaction_id, { correlationId: ctx.correlationId });
      return { data: { transaction }, summary: `Retrieved transaction ${input.transaction_id} for order ${input.order_id}.` };
    },
  }, callerHash);
}
