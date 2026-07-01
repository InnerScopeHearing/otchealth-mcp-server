import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCheckoutSession } from '../../stripe/full-client.js';

export function registerStripeCheckoutSessionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_checkout_session_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe checkout session',
      description: 'Retrieve a single checkout session by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      session_id: z.string().describe('Checkout session ID (cs_...).'),
    },
    outputShape: {
      id: z.string(),
      status: z.string().nullable(),
      mode: z.string(),
      customer: z.string().nullable(),
      amount_total: z.number().nullable(),
      currency: z.string().nullable(),
      payment_status: z.string(),
      url: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const s = await getCheckoutSession(input.session_id);
      return {
        data: {
          id: s.id,
          status: s.status ?? null,
          mode: s.mode,
          customer: s.customer ?? null,
          amount_total: s.amount_total ?? null,
          currency: s.currency ?? null,
          payment_status: s.payment_status,
          url: s.url ?? null,
          created: new Date(s.created * 1000).toISOString(),
        },
        summary: `Checkout session ${s.id}: ${s.status}, ${s.mode}, payment_status=${s.payment_status}.`,
      };
    },
  }, callerHash);
}
