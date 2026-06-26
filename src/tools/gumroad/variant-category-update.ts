import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateVariantCategory } from '../../gumroad/full-client.js';

export function registerGumroadVariantCategoryUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_variant_category_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Gumroad variant category',
      description: 'Rename an existing variant category on a Gumroad product. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      variant_category_id: z.string().describe('Variant category ID to update.'),
      title: z.string().describe('New title for the variant category.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      variant_category: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would rename variant category ${input.variant_category_id} to "${input.title}". Pass dry_run=false to apply.`,
        };
      }
      const resp = await updateVariantCategory(input.product_id, input.variant_category_id, input.title);
      return {
        data: { executed: true, dry_run: false, variant_category: resp.variant_category ?? resp },
        audit: { before: null, after: input },
        summary: `Renamed variant category ${input.variant_category_id} to "${input.title}".`,
      };
    },
  }, callerHash);
}
