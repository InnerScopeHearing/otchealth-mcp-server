import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { refundSale } from '../../gumroad/full-client.js';

export function registerGumroadSaleRefund(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_sale_refund',
    category: 'write_orchestrated',
    annotations: {
      title: 'Refund Gumroad sale',
      description: 'Issue a full or partial refund for a Gumroad sale. Money movement — irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      sale_id: z.string().describe('Gumroad sale ID to refund.'),
      amount_cents: z.number().int().optional().describe('Amount to refund in cents. Omit for a full refund.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      sale: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        const amtStr = input.amount_cents !== undefined ? `$${(input.amount_cents / 100).toFixed(2)} partial` : 'full';
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would issue ${amtStr} refund on sale ${input.sale_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await refundSale(input.sale_id, input.amount_cents);
      return {
        data: { executed: true, dry_run: false, sale: resp.sale ?? resp },
        audit: { before: null, after: input },
        summary: `Refunded sale ${input.sale_id}${input.amount_cents !== undefined ? ` ($${(input.amount_cents / 100).toFixed(2)} partial)` : ' (full)'}.`,
      };
    },
  }, callerHash);
}
