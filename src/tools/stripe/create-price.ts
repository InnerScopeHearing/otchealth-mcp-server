/**
 * stripe_create_price — POST /v1/prices
 *
 * Category: write_orchestrated (sets the pricing logic for a product; directly determines
 * what customers are billed — wrong values affect revenue permanently).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPrice } from '../../stripe/write-client.js';

export function registerStripeCreatePrice(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'stripe_create_price',
      category: 'write_orchestrated',
      annotations: {
        title: 'Create Stripe price',
        description:
          'Create a price for an existing Stripe product. Amount is in CENTS. For subscriptions, ' +
          'set recurring.interval. Prices are immutable once created — archive and recreate to change amount. ' +
          'Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        product: z
          .string()
          .min(1)
          .describe('Stripe product ID to attach this price to (prod_…).'),
        currency: z
          .string()
          .length(3)
          .toLowerCase()
          .describe('ISO 4217 currency code in lowercase (e.g. "usd", "eur", "gbp").'),
        unit_amount: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Price amount in CENTS (e.g. 2999 = $29.99). Required for fixed pricing.'),
        recurring_interval: z
          .enum(['day', 'week', 'month', 'year'])
          .optional()
          .describe('Billing interval for recurring/subscription prices. Omit for one-time prices.'),
        recurring_interval_count: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Number of intervals between billings (e.g. 3 with "month" = every 3 months). Default 1.'),
        nickname: z
          .string()
          .optional()
          .describe('Internal label for this price (not shown to customers).'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Key-value metadata to attach to the price (max 50 keys).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        price_id: z.string().nullable(),
        product: z.string().nullable(),
        currency: z.string().nullable(),
        unit_amount_cents: z.number().nullable(),
        type: z.string().nullable(),
        recurring: z.unknown().nullable(),
        active: z.boolean().nullable(),
      },
      handler: async (input, ctx) => {
        const recurringObj =
          input.recurring_interval
            ? {
                interval: input.recurring_interval,
                ...(input.recurring_interval_count !== undefined && {
                  interval_count: input.recurring_interval_count,
                }),
              }
            : undefined;

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              price_id: null,
              product: input.product,
              currency: input.currency,
              unit_amount_cents: input.unit_amount ?? null,
              type: recurringObj ? 'recurring' : 'one_time',
              recurring: recurringObj ?? null,
              active: true,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would create ${recurringObj ? 'recurring' : 'one-time'} price ` +
              `${input.unit_amount !== undefined ? `${input.unit_amount} cents` : '(custom)'} ${input.currency.toUpperCase()} ` +
              `for product ${input.product}. Pass dry_run=false to apply.`,
          };
        }

        const upstream = await createPrice({
          currency: input.currency,
          product: input.product,
          unit_amount: input.unit_amount,
          recurring: recurringObj,
          nickname: input.nickname,
          metadata: input.metadata,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            price_id: upstream.id ?? null,
            product: upstream.product ?? null,
            currency: upstream.currency ?? null,
            unit_amount_cents: upstream.unit_amount ?? null,
            type: upstream.type ?? null,
            recurring: upstream.recurring ?? null,
            active: upstream.active ?? null,
          },
          audit: { before: null, after: input },
          summary: `Created Stripe price ${upstream.id} (${upstream.unit_amount} ${upstream.currency}, ${upstream.type}).`,
        };
      },
    },
    callerHash,
  );
}
