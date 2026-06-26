import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPayout } from '../../stripe/full-client.js';

export function registerStripePayoutGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payout_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe payout',
      description: 'Retrieve a single payout by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      payout_id: z.string().describe('Payout ID (po_...).'),
    },
    outputShape: {
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      arrival_date: z.string().nullable(),
      method: z.string(),
      description: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const p = await getPayout(input.payout_id);
      return {
        data: {
          id: p.id,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
          method: p.method,
          description: p.description ?? null,
        },
        summary: `Payout ${p.id}: ${p.status}, ${p.currency} ${p.amount / 100}.`,
      };
    },
  }, callerHash);
}
