import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateDraftOrder } from '../../shopify/full-client.js';

export function registerShopifyDraftOrderUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_draft_order_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a draft order',
      description: 'Update note, tags, email, or other fields on a draft order via PUT /draft_orders/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      draft_order_id: z.union([z.string(), z.number()]).describe('Shopify draft order ID to update.'),
      note: z.string().optional().describe('Staff-facing note.'),
      tags: z.string().optional().describe('Comma-separated tags (replaces existing).'),
      email: z.string().email().optional().describe('Customer email for the draft order.'),
      tax_exempt: z.boolean().optional().describe('Whether the order is tax exempt.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      draft_order: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, draft_order: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update draft order ${input.draft_order_id}. Pass dry_run=false to apply.`,
        };
      }
      const { draft_order_id, ...patch } = input;
      const draft_order = await updateDraftOrder(draft_order_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, draft_order },
        audit: { before: null, after: input },
        summary: `Draft order ${draft_order_id} updated.`,
      };
    },
  }, callerHash);
}
