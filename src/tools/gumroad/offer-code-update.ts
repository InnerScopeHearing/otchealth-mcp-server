import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateOfferCode } from '../../gumroad/full-client.js';

export function registerGumroadOfferCodeUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_offer_code_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Gumroad offer code',
      description: 'Update the maximum redemption count of an existing Gumroad offer code. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      offer_code_id: z.string().describe('Offer code ID to update.'),
      max_purchase_count: z.number().int().optional().describe('New maximum redemption count.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      offer_code: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update offer code ${input.offer_code_id} max_purchase_count=${input.max_purchase_count}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await updateOfferCode(input.product_id, input.offer_code_id, {
        max_purchase_count: input.max_purchase_count,
      });
      return {
        data: { executed: true, dry_run: false, offer_code: resp.offer_code ?? resp },
        audit: { before: null, after: input },
        summary: `Updated offer code ${input.offer_code_id}.`,
      };
    },
  }, callerHash);
}
