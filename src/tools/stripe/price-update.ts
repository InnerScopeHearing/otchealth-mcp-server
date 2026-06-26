import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updatePrice } from '../../stripe/full-client.js';

export function registerStripePriceUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_price_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Stripe price',
      description: 'Update active status, nickname, or metadata on a price. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      price_id: z.string().describe('Price ID (price_...) to update.'),
      active: z.boolean().optional().describe('Enable or disable the price.'),
      nickname: z.string().optional().describe('Internal display name.'),
      lookup_key: z.string().optional().describe('Lookup key to set.'),
      transfer_lookup_key: z.boolean().optional().describe('Migrate lookup key from the existing price if true.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      price_id: z.string().nullable(),
      active: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, price_id: input.price_id, active: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update price ${input.price_id}. Pass dry_run=false to apply.`,
        };
      }
      const { price_id, ...params } = input;
      const upstream = await updatePrice(price_id, params);
      return {
        data: { executed: true, dry_run: false, price_id: upstream.id, active: upstream.active },
        audit: { before: null, after: input },
        summary: `Updated price ${upstream.id} (active: ${upstream.active}).`,
      };
    },
  }, callerHash);
}
