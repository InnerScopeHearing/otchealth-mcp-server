import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getRefund } from '../../stripe/full-client.js';

export function registerStripeRefundGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_refund_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe refund',
      description: 'Retrieve a single refund by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      refund_id: z.string().describe('Refund ID (re_...).'),
    },
    outputShape: {
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      reason: z.string().nullable(),
      charge: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const r = await getRefund(input.refund_id);
      return {
        data: {
          id: r.id,
          amount: r.amount,
          currency: r.currency,
          status: r.status,
          reason: r.reason ?? null,
          charge: r.charge ?? null,
          created: new Date(r.created * 1000).toISOString(),
        },
        summary: `Refund ${r.id}: ${r.status}, ${r.currency} ${r.amount / 100}.`,
      };
    },
  }, callerHash);
}
