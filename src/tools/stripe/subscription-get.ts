import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSubscription } from '../../stripe/full-client.js';

export function registerStripeSubscriptionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe subscription',
      description: 'Retrieve a single subscription by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      subscription_id: z.string().describe('Stripe subscription ID (sub_...).'),
    },
    outputShape: {
      id: z.string(),
      status: z.string(),
      customer: z.string(),
      current_period_start: z.string().nullable(),
      current_period_end: z.string().nullable(),
      cancel_at_period_end: z.boolean(),
      items: z.array(z.unknown()),
    },
    handler: async (input, _ctx) => {
      const s = await getSubscription(input.subscription_id);
      return {
        data: {
          id: s.id,
          status: s.status,
          customer: s.customer,
          current_period_start: s.current_period_start ? new Date(s.current_period_start * 1000).toISOString() : null,
          current_period_end: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
          cancel_at_period_end: s.cancel_at_period_end ?? false,
          items: s.items?.data ?? [],
        },
        summary: `Subscription ${s.id} status: ${s.status}.`,
      };
    },
  }, callerHash);
}
