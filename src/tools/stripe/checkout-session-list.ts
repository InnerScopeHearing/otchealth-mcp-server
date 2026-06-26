import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCheckoutSessions } from '../../stripe/full-client.js';

export function registerStripeCheckoutSessionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_checkout_session_list',
    category: 'read',
    annotations: {
      title: 'List Stripe checkout sessions',
      description: 'List checkout sessions, optionally filtered by customer, payment intent, or status.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      customer: z.string().optional().describe('Filter by customer ID.'),
      payment_intent: z.string().optional().describe('Filter by payment intent ID.'),
      subscription: z.string().optional().describe('Filter by subscription ID.'),
      status: z.enum(['open', 'complete', 'expired']).optional().describe('Filter by session status.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      sessions: z.array(z.object({
        id: z.string(),
        status: z.string().nullable(),
        mode: z.string(),
        customer: z.string().nullable(),
        amount_total: z.number().nullable(),
        currency: z.string().nullable(),
        created: z.string(),
        url: z.string().nullable(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listCheckoutSessions({
        limit: input.limit ?? 10,
        customer: input.customer,
        payment_intent: input.payment_intent,
        subscription: input.subscription,
        status: input.status,
        starting_after: input.starting_after,
      });
      const sessions = (result.data ?? []).map((s: any) => ({
        id: s.id,
        status: s.status ?? null,
        mode: s.mode,
        customer: s.customer ?? null,
        amount_total: s.amount_total ?? null,
        currency: s.currency ?? null,
        created: new Date(s.created * 1000).toISOString(),
        url: s.url ?? null,
      }));
      return {
        data: { sessions, count: sessions.length, has_more: result.has_more ?? false },
        summary: `Found ${sessions.length} checkout session(s).`,
      };
    },
  }, callerHash);
}
