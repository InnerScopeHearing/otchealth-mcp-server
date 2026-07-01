import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteRedirectListItems } from '../../cloudflare/full-client.js';

export function registerCloudflareRedirectListDeleteItems(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_redirect_list_delete_items',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete items from bulk redirect list',
      description: 'Remove specific redirect entries from a bulk redirect list by item ID. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().describe('Cloudflare account ID.'),
      list_id: z.string().describe('Redirect list ID.'),
      item_ids: z.array(z.string()).min(1).describe('Item IDs to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      result: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, result: null },
          audit: { before: { item_ids: input.item_ids }, after: null },
          summary: `DRY RUN: would delete ${input.item_ids.length} item(s) from list ${input.list_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await deleteRedirectListItems(input.account_id, input.list_id, input.item_ids);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: { item_ids: input.item_ids }, after: null },
        summary: `Deleted ${input.item_ids.length} item(s) from list ${input.list_id}.`,
      };
    },
  }, callerHash);
}
