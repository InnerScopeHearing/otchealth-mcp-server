import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelPayout } from '../../stripe/full-client.js';

export function registerStripePayoutCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payout_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Cancel Stripe payout',
      description: 'Cancel a pending payout before it reaches the bank. Money movement. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      payout_id: z.string().describe('Payout ID (po_...) to cancel.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      payout_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, payout_id: input.payout_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel payout ${input.payout_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await cancelPayout(input.payout_id);
      return {
        data: { executed: true, dry_run: false, payout_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Cancelled payout ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
