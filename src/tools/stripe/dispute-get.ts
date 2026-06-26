import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDispute } from '../../stripe/full-client.js';

export function registerStripeDisputeGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_dispute_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe dispute',
      description: 'Retrieve a single dispute (chargeback) by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      dispute_id: z.string().describe('Dispute ID (dp_...).'),
    },
    outputShape: {
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      reason: z.string(),
      charge: z.string(),
      evidence_due_by: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const d = await getDispute(input.dispute_id);
      return {
        data: {
          id: d.id,
          amount: d.amount,
          currency: d.currency,
          status: d.status,
          reason: d.reason,
          charge: d.charge,
          evidence_due_by: d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString() : null,
          created: new Date(d.created * 1000).toISOString(),
        },
        summary: `Dispute ${d.id}: ${d.status}, ${d.reason}, ${d.currency} ${d.amount / 100}.`,
      };
    },
  }, callerHash);
}
