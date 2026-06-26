import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deletePriceRule } from '../../shopify/full-client.js';

export function registerShopifyPriceRuleDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_price_rule_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a price rule',
      description: 'Permanently delete a price rule and all its associated discount codes via DELETE /price_rules/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      price_rule_id: z.union([z.string(), z.number()]).describe('Shopify price rule ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_price_rule_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_price_rule_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete price rule ${input.price_rule_id} and all its discount codes. Pass dry_run=false to apply.`,
        };
      }
      await deletePriceRule(input.price_rule_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_price_rule_id: input.price_rule_id },
        audit: { before: null, after: input },
        summary: `Price rule ${input.price_rule_id} deleted.`,
      };
    },
  }, callerHash);
}
