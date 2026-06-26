/**
 * stripe_create_payment_link — POST /v1/payment_links
 *
 * Category: write_orchestrated (generates a public URL that accepts real card payments;
 * directly enables money collection — CFO approval scope).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPaymentLink } from '../../stripe/write-client.js';

export function registerStripeCreatePaymentLink(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'stripe_create_payment_link',
      category: 'write_orchestrated',
      annotations: {
        title: 'Create Stripe payment link',
        description:
          'Create a hosted payment link (no-code checkout URL) for one or more price line items. ' +
          'The generated URL is publicly accessible and immediately accepts real payments. ' +
          'Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        line_items: z
          .array(
            z.object({
              price: z.string().min(1).describe('Stripe price ID (price_…).'),
              quantity: z.number().int().positive().describe('Quantity of this line item.'),
            }),
          )
          .min(1)
          .describe('One or more price+quantity pairs to include in the payment link.'),
        after_completion_type: z
          .enum(['hosted_confirmation', 'redirect'])
          .optional()
          .describe('What to show after payment: hosted confirmation page (default) or redirect.'),
        after_completion_redirect_url: z
          .string()
          .url()
          .optional()
          .describe('URL to redirect to after successful payment (required if after_completion_type=redirect).'),
        allow_promotion_codes: z
          .boolean()
          .optional()
          .describe('Allow customers to enter coupon/promo codes at checkout.'),
        collect_phone: z
          .boolean()
          .optional()
          .describe('Require phone number collection at checkout.'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Key-value metadata to attach to the payment link (max 50 keys).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        payment_link_id: z.string().nullable(),
        url: z.string().nullable(),
        active: z.boolean().nullable(),
        line_item_count: z.number(),
      },
      handler: async (input, ctx) => {
        if (
          input.after_completion_type === 'redirect' &&
          !input.after_completion_redirect_url
        ) {
          throw new Error(
            'after_completion_redirect_url is required when after_completion_type is "redirect".',
          );
        }

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              payment_link_id: null,
              url: null,
              active: null,
              line_item_count: input.line_items.length,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create payment link with ${input.line_items.length} line item(s). Pass dry_run=false to apply.`,
          };
        }

        const afterCompletion = input.after_completion_type
          ? {
              type: input.after_completion_type,
              ...(input.after_completion_type === 'redirect' && input.after_completion_redirect_url
                ? { redirect: { url: input.after_completion_redirect_url } }
                : {}),
            }
          : undefined;

        const upstream = await createPaymentLink({
          line_items: input.line_items,
          after_completion: afterCompletion as any,
          allow_promotion_codes: input.allow_promotion_codes,
          phone_number_collection:
            input.collect_phone !== undefined
              ? { enabled: input.collect_phone }
              : undefined,
          metadata: input.metadata,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            payment_link_id: upstream.id ?? null,
            url: upstream.url ?? null,
            active: upstream.active ?? null,
            line_item_count: input.line_items.length,
          },
          audit: { before: null, after: input },
          summary: `Created payment link ${upstream.id}: ${upstream.url}`,
        };
      },
    },
    callerHash,
  );
}
