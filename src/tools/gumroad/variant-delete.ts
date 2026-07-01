import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteVariant } from '../../gumroad/full-client.js';

export function registerGumroadVariantDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_variant_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Gumroad variant',
      description: 'Permanently delete a variant from a Gumroad variant category. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      variant_category_id: z.string().describe('Variant category ID.'),
      variant_id: z.string().describe('Variant ID to delete.'),
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
          summary: `DRY RUN: would delete variant ${input.variant_id} from category ${input.variant_category_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await deleteVariant(input.product_id, input.variant_category_id, input.variant_id);
      return {
        data: { executed: true, dry_run: false, success: resp.success },
        audit: { before: null, after: input },
        summary: `Deleted variant ${input.variant_id}.`,
      };
    },
  }, callerHash);
}
