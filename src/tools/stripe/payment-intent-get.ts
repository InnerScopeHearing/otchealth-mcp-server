import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPaymentIntent } from '../../stripe/full-client.js';

export function registerStripePaymentIntentGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_intent_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe payment intent',
      description: 'Retrieve a single payment intent by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      payment_intent_id: z.string().describe('Payment intent ID (pi_...).'),
    },
    outputShape: {
      id: z.string(),
      status: z.string(),
      amount: z.number(),
      currency: z.string(),
      customer: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const pi = await getPaymentIntent(input.payment_intent_id);
      return {
        data: {
          id: pi.id,
          status: pi.status,
          amount: pi.amount,
          currency: pi.currency,
          customer: pi.customer ?? null,
          created: new Date(pi.created * 1000).toISOString(),
        },
        summary: `Payment intent ${pi.id}: ${pi.status}, ${pi.currency} ${pi.amount / 100}.`,
      };
    },
  }, callerHash);
}
