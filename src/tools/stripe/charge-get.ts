import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCharge } from '../../stripe/full-client.js';

export function registerStripeChargeGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_charge_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe charge',
      description: 'Retrieve a single charge by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      charge_id: z.string().describe('Charge ID (ch_...).'),
    },
    outputShape: {
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      paid: z.boolean(),
      customer: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const c = await getCharge(input.charge_id);
      return {
        data: {
          id: c.id,
          amount: c.amount,
          currency: c.currency,
          status: c.status,
          paid: c.paid,
          customer: c.customer ?? null,
          created: new Date(c.created * 1000).toISOString(),
        },
        summary: `Charge ${c.id}: ${c.status}, ${c.currency} ${c.amount / 100}.`,
      };
    },
  }, callerHash);
}
