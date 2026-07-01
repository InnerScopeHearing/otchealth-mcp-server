import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { resendSaleReceipt } from '../../gumroad/full-client.js';

export function registerGumroadSaleResendReceipt(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_sale_resend_receipt',
    category: 'write_simple',
    annotations: {
      title: 'Resend Gumroad sale receipt',
      description: 'Resend the purchase receipt email for a Gumroad sale to the buyer. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      sale_id: z.string().describe('Gumroad sale ID whose receipt to resend.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      success: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would resend receipt for sale ${input.sale_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await resendSaleReceipt(input.sale_id);
      return {
        data: { executed: true, dry_run: false, success: resp.success },
        audit: { before: null, after: input },
        summary: `Resent receipt for sale ${input.sale_id}.`,
      };
    },
  }, callerHash);
}
