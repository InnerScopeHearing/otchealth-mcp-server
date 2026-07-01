import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateMetafield } from '../../shopify/full-client.js';

export function registerShopifyMetafieldUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_metafield_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a metafield',
      description: 'Update the value (and optionally type) of an existing metafield via PUT /metafields/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      metafield_id: z.union([z.string(), z.number()]).describe('Shopify metafield ID to update.'),
      value: z.string().min(1).describe('New metafield value.'),
      type: z.string().optional().describe('Metafield type, e.g. "single_line_text_field", "json". Omit to keep existing type.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      metafield: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, metafield: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update metafield ${input.metafield_id}. Pass dry_run=false to apply.`,
        };
      }
      const { metafield_id, ...patch } = input;
      const metafield = await updateMetafield(metafield_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, metafield },
        audit: { before: null, after: input },
        summary: `Metafield ${metafield_id} updated.`,
      };
    },
  }, callerHash);
}
