import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDraftOrder } from '../../shopify/full-client.js';

export function registerShopifyDraftOrderDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_draft_order_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a draft order',
      description: 'Permanently delete a draft order via DELETE /draft_orders/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      draft_order_id: z.union([z.string(), z.number()]).describe('Shopify draft order ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_draft_order_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_draft_order_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete draft order ${input.draft_order_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteDraftOrder(input.draft_order_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_draft_order_id: input.draft_order_id },
        audit: { before: null, after: input },
        summary: `Draft order ${input.draft_order_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
