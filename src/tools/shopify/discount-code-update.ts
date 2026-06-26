import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateDiscountCode } from '../../shopify/full-client.js';

export function registerShopifyDiscountCodeUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_discount_code_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a discount code',
      description: 'Change the code string or usage limit on an existing discount code via PUT /price_rules/{id}/discount_codes/{code_id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      price_rule_id: z.union([z.string(), z.number()]).describe('Shopify price rule ID.'),
      discount_code_id: z.union([z.string(), z.number()]).describe('Shopify discount code ID to update.'),
      code: z.string().optional().describe('New discount code string, e.g. "SAVE20".'),
      usage_limit: z.number().int().nullable().optional().describe('Per-code usage limit. Set to null to remove limit.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      discount_code: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, discount_code: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update discount code ${input.discount_code_id}. Pass dry_run=false to apply.`,
        };
      }
      const { price_rule_id, discount_code_id, ...patch } = input;
      const discount_code = await updateDiscountCode(price_rule_id, discount_code_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, discount_code },
        audit: { before: null, after: input },
        summary: `Discount code ${discount_code_id} updated.`,
      };
    },
  }, callerHash);
}
