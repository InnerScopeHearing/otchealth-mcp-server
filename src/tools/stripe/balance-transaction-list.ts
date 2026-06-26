import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listBalanceTransactions } from '../../stripe/full-client.js';

export function registerStripeBalanceTransactionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_balance_transaction_list',
    category: 'read',
    annotations: {
      title: 'List Stripe balance transactions',
      description: 'List balance transactions (charges, refunds, payouts, etc.) from the Stripe ledger.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      type: z.string().optional().describe('Filter by type: charge, refund, payout, transfer, etc.'),
      payout: z.string().optional().describe('Filter by payout ID.'),
      source: z.string().optional().describe('Filter by source object ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
      created_gte: z.number().int().optional().describe('Created >= (Unix timestamp).'),
      created_lte: z.number().int().optional().describe('Created <= (Unix timestamp).'),
    },
    outputShape: {
      transactions: z.array(z.object({
        id: z.string(),
        amount: z.number(),
        currency: z.string(),
        type: z.string(),
        net: z.number(),
        fee: z.number(),
        created: z.string(),
        description: z.string().nullable(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listBalanceTransactions({
        limit: input.limit ?? 10,
        type: input.type,
        payout: input.payout,
        source: input.source,
        starting_after: input.starting_after,
        created_gte: input.created_gte,
        created_lte: input.created_lte,
      });
      const transactions = (result.data ?? []).map((t: any) => ({
        id: t.id,
        amount: t.amount,
        currency: t.currency,
        type: t.type,
        net: t.net,
        fee: t.fee,
        created: new Date(t.created * 1000).toISOString(),
        description: t.description ?? null,
      }));
      return {
        data: { transactions, count: transactions.length, has_more: result.has_more ?? false },
        summary: `Found ${transactions.length} balance transaction(s).`,
      };
    },
  }, callerHash);
}
