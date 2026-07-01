import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSetupIntents } from '../../stripe/full-client.js';

export function registerStripeSetupIntentList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_setup_intent_list',
    category: 'read',
    annotations: {
      title: 'List Stripe setup intents',
      description: 'List setup intents for storing payment methods.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      customer: z.string().optional().describe('Filter by customer ID.'),
      payment_method: z.string().optional().describe('Filter by payment method ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      setup_intents: z.array(z.object({
        id: z.string(),
        status: z.string(),
        customer: z.string().nullable(),
        payment_method: z.string().nullable(),
        usage: z.string(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listSetupIntents({
        limit: input.limit ?? 10,
        customer: input.customer,
        payment_method: input.payment_method,
        starting_after: input.starting_after,
      });
      const setup_intents = (result.data ?? []).map((si: any) => ({
        id: si.id,
        status: si.status,
        customer: si.customer ?? null,
        payment_method: si.payment_method ?? null,
        usage: si.usage,
        created: new Date(si.created * 1000).toISOString(),
      }));
      return {
        data: { setup_intents, count: setup_intents.length, has_more: result.has_more ?? false },
        summary: `Found ${setup_intents.length} setup intent(s).`,
      };
    },
  }, callerHash);
}
