import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { closeDispute } from '../../stripe/full-client.js';

export function registerStripeDisputeClose(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_dispute_close',
    category: 'write_orchestrated',
    annotations: {
      title: 'Close Stripe dispute',
      description: 'Close a dispute, accepting the chargeback (loss). Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      dispute_id: z.string().describe('Dispute ID (dp_...) to close/concede.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      dispute_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, dispute_id: input.dispute_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would close (concede) dispute ${input.dispute_id}. This is irreversible. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await closeDispute(input.dispute_id);
      return {
        data: { executed: true, dry_run: false, dispute_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Closed dispute ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
