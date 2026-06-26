import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteOfferCode } from '../../gumroad/full-client.js';

export function registerGumroadOfferCodeDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_offer_code_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Gumroad offer code',
      description: 'Permanently delete an offer code from a Gumroad product. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      offer_code_id: z.string().describe('Offer code ID to delete.'),
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
          summary: `DRY RUN: would delete offer code ${input.offer_code_id} from product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await deleteOfferCode(input.product_id, input.offer_code_id);
      return {
        data: { executed: true, dry_run: false, success: resp.success },
        audit: { before: null, after: input },
        summary: `Deleted offer code ${input.offer_code_id} from product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
