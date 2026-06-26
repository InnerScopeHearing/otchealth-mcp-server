import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPaymentMethod } from '../../stripe/full-client.js';

export function registerStripePaymentMethodGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_method_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe payment method',
      description: 'Retrieve a single payment method by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      payment_method_id: z.string().describe('Payment method ID (pm_...).'),
    },
    outputShape: {
      id: z.string(),
      type: z.string(),
      customer: z.string().nullable(),
      billing_details: z.unknown(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const pm = await getPaymentMethod(input.payment_method_id);
      return {
        data: {
          id: pm.id,
          type: pm.type,
          customer: pm.customer ?? null,
          billing_details: pm.billing_details ?? {},
          created: new Date(pm.created * 1000).toISOString(),
        },
        summary: `Payment method ${pm.id}: ${pm.type}.`,
      };
    },
  }, callerHash);
}
