import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBalanceTransaction } from '../../stripe/full-client.js';

export function registerStripeBalanceTransactionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_balance_transaction_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe balance transaction',
      description: 'Retrieve a single balance transaction by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      transaction_id: z.string().describe('Balance transaction ID (txn_...).'),
    },
    outputShape: {
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      type: z.string(),
      net: z.number(),
      fee: z.number(),
      created: z.string(),
      description: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const t = await getBalanceTransaction(input.transaction_id);
      return {
        data: {
          id: t.id,
          amount: t.amount,
          currency: t.currency,
          type: t.type,
          net: t.net,
          fee: t.fee,
          created: new Date(t.created * 1000).toISOString(),
          description: t.description ?? null,
        },
        summary: `Balance transaction ${t.id}: ${t.type}, ${t.currency} ${t.amount / 100} (net ${t.net / 100}).`,
      };
    },
  }, callerHash);
}
