import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCharges } from '../../stripe/api-client.js';

export function registerStripeListCharges(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_list_charges',
    category: 'read',
    annotations: {
      title: 'List Stripe charges',
      description: 'List recent charges. Amounts in dollars (converted from cents).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      customer: z.string().optional().describe('Filter by Stripe customer ID.'),
    },
    outputShape: {
      charges: z.array(z.object({ id: z.string(), amount: z.number(), currency: z.string(), status: z.string(), created: z.string(), customer: z.string().nullable() })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listCharges({ limit: input.limit ?? 10, customer: input.customer });
      const charges = (result.data ?? []).map((c: any) => ({
        id: c.id, amount: c.amount / 100, currency: c.currency, status: c.status,
        created: new Date(c.created * 1000).toISOString(), customer: c.customer ?? null,
      }));
      return {
        data: { charges, count: charges.length, has_more: result.has_more ?? false },
        summary: `Found ${charges.length} charge(s).`,
      };
    },
  }, callerHash);
}
