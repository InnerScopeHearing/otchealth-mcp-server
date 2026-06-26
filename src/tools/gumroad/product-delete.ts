import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProduct } from '../../gumroad/full-client.js';

export function registerGumroadProductDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_product_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Gumroad product',
      description: 'Permanently delete a Gumroad product. Irreversible — existing customers retain access to their purchases. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      product_id: z.string(),
      success: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, product_id: input.product_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await deleteProduct(input.product_id);
      return {
        data: { executed: true, dry_run: false, product_id: input.product_id, success: resp.success },
        audit: { before: null, after: input },
        summary: `Deleted product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
