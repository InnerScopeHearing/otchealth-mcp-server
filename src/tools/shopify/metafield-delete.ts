import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteMetafield } from '../../shopify/full-client.js';

export function registerShopifyMetafieldDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_metafield_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a metafield',
      description: 'Permanently delete a metafield via DELETE /metafields/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      metafield_id: z.union([z.string(), z.number()]).describe('Shopify metafield ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_metafield_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_metafield_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete metafield ${input.metafield_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteMetafield(input.metafield_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_metafield_id: input.metafield_id },
        audit: { before: null, after: input },
        summary: `Metafield ${input.metafield_id} deleted.`,
      };
    },
  }, callerHash);
}
