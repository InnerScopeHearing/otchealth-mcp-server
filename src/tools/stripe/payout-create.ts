import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPayout } from '../../stripe/full-client.js';

export function registerStripePayoutCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payout_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create Stripe payout',
      description: 'Initiate a payout to the connected bank account. Money movement — requires CTO approval. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      amount: z.number().int().min(1).describe('Amount to pay out in cents.'),
      currency: z.string().length(3).describe('ISO 4217 currency code (e.g. usd).'),
      description: z.string().optional().describe('Internal description.'),
      destination: z.string().optional().describe('Bank account or card ID to pay out to.'),
      method: z.enum(['instant', 'standard']).optional().describe('Payout method. instant = faster, higher cost.'),
      statement_descriptor: z.string().max(22).optional().describe('Statement descriptor (max 22 chars).'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      payout_id: z.string().nullable(),
      status: z.string().nullable(),
      amount: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, payout_id: null, status: null, amount: input.amount },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create payout of ${input.currency} ${input.amount / 100}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createPayout({
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        destination: input.destination,
        method: input.method,
        statement_descriptor: input.statement_descriptor,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, payout_id: upstream.id, status: upstream.status, amount: upstream.amount },
        audit: { before: null, after: input },
        summary: `Created payout ${upstream.id} (${upstream.status}) for ${upstream.currency} ${upstream.amount / 100}.`,
      };
    },
  }, callerHash);
}
