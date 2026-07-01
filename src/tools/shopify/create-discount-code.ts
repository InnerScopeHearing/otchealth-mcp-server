import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPriceRuleWithCode } from '../../shopify/write-client.js';

export function registerShopifyCreateDiscountCode(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_create_discount_code',
      category: 'write_simple',
      annotations: {
        title: 'Create a Shopify discount code (price rule + code)',
        description:
          'Create a price rule and its first discount code in one call via ' +
          'POST /price_rules.json then POST /price_rules/{id}/discount_codes.json. ' +
          'Supports percentage and fixed-amount discounts. For shipping discounts, set target_type="shipping_line". ' +
          'Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        // Price rule fields
        rule_title: z
          .string()
          .min(1)
          .describe('Internal name for the price rule (visible in Shopify Admin > Discounts).'),
        target_type: z
          .enum(['line_item', 'shipping_line'])
          .default('line_item')
          .describe('"line_item" for product discounts; "shipping_line" for free/discounted shipping.'),
        target_selection: z
          .enum(['all', 'entitled'])
          .default('all')
          .describe('"all" applies to all items; "entitled" restricts to specified products/collections.'),
        allocation_method: z
          .enum(['across', 'each'])
          .default('across')
          .describe('"across" splits discount across all entitled items; "each" applies to each item independently.'),
        value_type: z
          .enum(['fixed_amount', 'percentage'])
          .describe('Whether the discount is a fixed dollar amount or a percentage.'),
        value: z
          .string()
          .describe(
            'Discount magnitude as a NEGATIVE string (Shopify convention), e.g. "-10.00" for $10 off ' +
              'or "-15.0" for 15%. Must be negative.',
          )
          .refine(
            (v) => {
              const n = parseFloat(v);
              return !isNaN(n) && n < 0;
            },
            { message: 'value must be a negative number string, e.g. "-10.00" or "-15.0"' },
          ),
        customer_selection: z
          .enum(['all', 'prerequisite'])
          .default('all')
          .describe('"all" allows any customer; "prerequisite" restricts to specific customer segments.'),
        starts_at: z
          .string()
          .describe('ISO 8601 datetime when the discount becomes active, e.g. "2026-07-01T00:00:00Z".'),
        ends_at: z
          .string()
          .optional()
          .describe('ISO 8601 expiry datetime. Omit for no expiry.'),
        usage_limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum total redemptions across all customers. Omit for unlimited.'),
        once_per_customer: z
          .boolean()
          .optional()
          .default(false)
          .describe('Whether each customer can only use this discount once.'),
        prerequisite_subtotal_min: z
          .string()
          .optional()
          .describe(
            'Minimum order subtotal to qualify (as a string), e.g. "50.00". ' +
              'Used with customer_selection="prerequisite".',
          ),

        // Discount code fields
        code: z
          .string()
          .min(1)
          .max(255)
          .toUpperCase()
          .describe('The coupon code customers enter at checkout, e.g. "SUMMER20". Converted to uppercase.'),
        code_usage_limit: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Per-code usage limit (separate from the price rule usage_limit). null = unlimited.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        price_rule: z.unknown().nullable(),
        discount_code: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              price_rule: null,
              discount_code: null,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would create price rule "${input.rule_title}" (${input.value_type} ${input.value}) ` +
              `and discount code "${input.code}". Pass dry_run=false to apply.`,
          };
        }

        const { price_rule, discount_code } = await createPriceRuleWithCode(
          {
            title: input.rule_title,
            target_type: input.target_type,
            target_selection: input.target_selection,
            allocation_method: input.allocation_method,
            value_type: input.value_type,
            value: input.value,
            customer_selection: input.customer_selection,
            starts_at: input.starts_at,
            ends_at: input.ends_at,
            usage_limit: input.usage_limit,
            once_per_customer: input.once_per_customer,
            prerequisite_subtotal_range: input.prerequisite_subtotal_min
              ? { greater_than_or_equal_to: input.prerequisite_subtotal_min }
              : undefined,
          },
          {
            code: input.code,
            usage_limit: input.code_usage_limit ?? null,
          },
          { correlationId: ctx.correlationId },
        );

        return {
          data: {
            executed: true,
            dry_run: false,
            price_rule,
            discount_code,
          },
          audit: { before: null, after: input },
          summary: `Price rule "${input.rule_title}" created with discount code "${input.code}".`,
        };
      },
    },
    callerHash,
  );
}
