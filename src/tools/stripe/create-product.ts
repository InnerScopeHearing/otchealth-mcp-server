/**
 * stripe_create_product — POST /v1/products
 *
 * Category: write_orchestrated (creates a product record that can be attached to prices,
 * invoices, and payment links; part of the billing catalog setup flow).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProduct } from '../../stripe/write-client.js';

export function registerStripeCreateProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'stripe_create_product',
      category: 'write_orchestrated',
      annotations: {
        title: 'Create Stripe product',
        description:
          'Create a new product in the Stripe catalog. Products are the top-level billing entity; ' +
          'attach a price to make it purchasable. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        name: z
          .string()
          .min(1)
          .describe('Product name (shown on invoices and checkout).'),
        description: z
          .string()
          .optional()
          .describe('Product description (shown on checkout and invoices).'),
        active: z
          .boolean()
          .optional()
          .describe('Whether the product is active/available for purchase. Defaults to true.'),
        unit_label: z
          .string()
          .optional()
          .describe('Label for a single unit of this product (e.g. "seat", "unit"). Used on invoices.'),
        url: z
          .string()
          .url()
          .optional()
          .describe('A URL of a publicly-accessible webpage for this product.'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Key-value metadata to attach to the product (max 50 keys).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        product_id: z.string().nullable(),
        name: z.string().nullable(),
        active: z.boolean().nullable(),
        created: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              product_id: null,
              name: input.name,
              active: input.active ?? true,
              created: null,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create Stripe product "${input.name}". Pass dry_run=false to apply.`,
          };
        }

        const upstream = await createProduct({
          name: input.name,
          description: input.description,
          active: input.active,
          metadata: input.metadata,
          unit_label: input.unit_label,
          url: input.url,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            product_id: upstream.id ?? null,
            name: upstream.name ?? null,
            active: upstream.active ?? null,
            created: upstream.created
              ? new Date(upstream.created * 1000).toISOString()
              : null,
          },
          audit: { before: null, after: input },
          summary: `Created Stripe product ${upstream.id} ("${upstream.name}").`,
        };
      },
    },
    callerHash,
  );
}
