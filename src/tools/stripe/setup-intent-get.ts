import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSetupIntent } from '../../stripe/full-client.js';

export function registerStripeSetupIntentGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_setup_intent_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe setup intent',
      description: 'Retrieve a single setup intent by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      setup_intent_id: z.string().describe('Setup intent ID (seti_...).'),
    },
    outputShape: {
      id: z.string(),
      status: z.string(),
      customer: z.string().nullable(),
      payment_method: z.string().nullable(),
      usage: z.string(),
      description: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const si = await getSetupIntent(input.setup_intent_id);
      return {
        data: {
          id: si.id,
          status: si.status,
          customer: si.customer ?? null,
          payment_method: si.payment_method ?? null,
          usage: si.usage,
          description: si.description ?? null,
          created: new Date(si.created * 1000).toISOString(),
        },
        summary: `Setup intent ${si.id}: ${si.status}.`,
      };
    },
  }, callerHash);
}
