import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createVariantCategory } from '../../gumroad/full-client.js';

export function registerGumroadVariantCategoryCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_variant_category_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Gumroad variant category',
      description: 'Create a new variant category (e.g. "Size") on a Gumroad product. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      title: z.string().describe('Name for the variant category (e.g. "Size", "Color").'),
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
          summary: `DRY RUN: would create variant category "${input.title}" on product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await createVariantCategory(input.product_id, input.title);
      return {
        data: { executed: true, dry_run: false, variant_category: resp.variant_category ?? resp },
        audit: { before: null, after: input },
        summary: `Created variant category "${input.title}" on product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
