import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listDisputes } from '../../stripe/full-client.js';

export function registerStripeDisputeList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_dispute_list',
    category: 'read',
    annotations: {
      title: 'List Stripe disputes',
      description: 'List disputes (chargebacks). Filter by charge, payment intent, or status.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      charge: z.string().optional().describe('Filter by charge ID.'),
      payment_intent: z.string().optional().describe('Filter by payment intent ID.'),
      status: z.string().optional().describe('Filter by status: needs_response, under_review, won, lost, etc.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      disputes: z.array(z.object({
        id: z.string(),
        amount: z.number(),
        currency: z.string(),
        status: z.string(),
        reason: z.string(),
        charge: z.string(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listDisputes({
        limit: input.limit ?? 10,
        charge: input.charge,
        payment_intent: input.payment_intent,
        status: input.status,
        starting_after: input.starting_after,
      });
      const disputes = (result.data ?? []).map((d: any) => ({
        id: d.id,
        amount: d.amount,
        currency: d.currency,
        status: d.status,
        reason: d.reason,
        charge: d.charge,
        created: new Date(d.created * 1000).toISOString(),
      }));
      return {
        data: { disputes, count: disputes.length, has_more: result.has_more ?? false },
        summary: `Found ${disputes.length} dispute(s).`,
      };
    },
  }, callerHash);
}
