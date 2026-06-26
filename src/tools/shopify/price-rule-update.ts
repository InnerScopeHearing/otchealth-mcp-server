import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updatePriceRule } from '../../shopify/full-client.js';

export function registerShopifyPriceRuleUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_price_rule_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a price rule',
      description: 'Update title, value, dates, or usage limits on an existing price rule via PUT /price_rules/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      price_rule_id: z.union([z.string(), z.number()]).describe('Shopify price rule ID to update.'),
      title: z.string().optional().describe('New title for the price rule.'),
      value: z.string().optional().describe('Discount value (negative string for discounts, e.g. "-10.0" for 10% or $10 off).'),
      starts_at: z.string().optional().describe('ISO 8601 start date.'),
      ends_at: z.string().nullable().optional().describe('ISO 8601 end date. Set to null to remove expiry.'),
      usage_limit: z.number().int().nullable().optional().describe('Total usage limit. Set to null to remove limit.'),
      once_per_customer: z.boolean().optional().describe('Whether each customer can use this rule only once.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      price_rule: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, price_rule: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update price rule ${input.price_rule_id}. Pass dry_run=false to apply.`,
        };
      }
      const { price_rule_id, ...patch } = input;
      const price_rule = await updatePriceRule(price_rule_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, price_rule },
        audit: { before: null, after: input },
        summary: `Price rule ${price_rule_id} updated.`,
      };
    },
  }, callerHash);
}
