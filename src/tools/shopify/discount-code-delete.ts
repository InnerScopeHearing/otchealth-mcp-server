import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDiscountCode } from '../../shopify/full-client.js';

export function registerShopifyDiscountCodeDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_discount_code_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a discount code',
      description: 'Permanently delete a discount code via DELETE /price_rules/{id}/discount_codes/{code_id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      price_rule_id: z.union([z.string(), z.number()]).describe('Shopify price rule ID.'),
      discount_code_id: z.union([z.string(), z.number()]).describe('Shopify discount code ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_discount_code_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_discount_code_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete discount code ${input.discount_code_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteDiscountCode(input.price_rule_id, input.discount_code_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_discount_code_id: input.discount_code_id },
        audit: { before: null, after: input },
        summary: `Discount code ${input.discount_code_id} deleted.`,
      };
    },
  }, callerHash);
}
