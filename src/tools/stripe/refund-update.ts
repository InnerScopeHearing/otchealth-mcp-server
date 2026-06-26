import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateRefund } from '../../stripe/full-client.js';

export function registerStripeRefundUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_refund_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Stripe refund metadata',
      description: 'Update metadata on an existing refund. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      refund_id: z.string().describe('Refund ID (re_...) to update.'),
      metadata: z.record(z.string()).describe('Key-value metadata to set on the refund.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      refund_id: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, refund_id: input.refund_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update metadata on refund ${input.refund_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateRefund(input.refund_id, input.metadata);
      return {
        data: { executed: true, dry_run: false, refund_id: upstream.id },
        audit: { before: null, after: input },
        summary: `Updated refund ${upstream.id} metadata.`,
      };
    },
  }, callerHash);
}
