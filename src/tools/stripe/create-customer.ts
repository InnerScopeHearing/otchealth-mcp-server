/**
 * stripe_create_customer — POST /v1/customers
 *
 * Category: write_orchestrated (creates a billable identity in the payment system;
 * downstream impact on invoices, subscriptions, and stored payment methods).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCustomer } from '../../stripe/write-client.js';

export function registerStripeCreateCustomer(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'stripe_create_customer',
      category: 'write_orchestrated',
      annotations: {
        title: 'Create Stripe customer',
        description:
          'Create a new customer record in Stripe. At least one of email or name is recommended. ' +
          'Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        email: z
          .string()
          .email()
          .optional()
          .describe("Customer's email address. Used for receipts and customer portal."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("Customer's full name or business name."),
        phone: z
          .string()
          .optional()
          .describe("Customer's phone number in E.164 format (+15551234567)."),
        description: z
          .string()
          .optional()
          .describe('Internal description or note about this customer (not shown to customer).'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Key-value metadata attached to the customer (max 50 keys).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        customer_id: z.string().nullable(),
        email: z.string().nullable(),
        name: z.string().nullable(),
        created: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        if (!input.email && !input.name) {
          throw new Error('Provide at least one of email or name to create a customer.');
        }

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              customer_id: null,
              email: input.email ?? null,
              name: input.name ?? null,
              created: null,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create Stripe customer ${input.email ?? input.name}. Pass dry_run=false to apply.`,
          };
        }

        const upstream = await createCustomer({
          email: input.email,
          name: input.name,
          phone: input.phone,
          description: input.description,
          metadata: input.metadata,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            customer_id: upstream.id ?? null,
            email: upstream.email ?? null,
            name: upstream.name ?? null,
            created: upstream.created
              ? new Date(upstream.created * 1000).toISOString()
              : null,
          },
          audit: { before: null, after: input },
          summary: `Created Stripe customer ${upstream.id} (${upstream.email ?? upstream.name}).`,
        };
      },
    },
    callerHash,
  );
}
