import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { markSaleAsShipped } from '../../gumroad/full-client.js';

export function registerGumroadSaleMarkShipped(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_sale_mark_shipped',
    category: 'write_simple',
    annotations: {
      title: 'Mark Gumroad sale as shipped',
      description: 'Mark a physical-product Gumroad sale as shipped and optionally attach a tracking URL. Sends notification to buyer. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      sale_id: z.string().describe('Gumroad sale ID to mark as shipped.'),
      tracking_url: z.string().url().optional().describe('Optional carrier tracking URL to include in buyer notification.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      sale: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would mark sale ${input.sale_id} as shipped${input.tracking_url ? ` with tracking ${input.tracking_url}` : ''}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await markSaleAsShipped(input.sale_id, input.tracking_url);
      return {
        data: { executed: true, dry_run: false, sale: resp.sale ?? resp },
        audit: { before: null, after: input },
        summary: `Marked sale ${input.sale_id} as shipped.`,
      };
    },
  }, callerHash);
}
