/**
 * stripe_update_customer — POST /v1/customers/{id}
 *
 * Category: write_orchestrated (modifies a billable identity; metadata changes can affect
 * downstream automation, tax settings, and dunning flows).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCustomer } from '../../stripe/write-client.js';

export function registerStripeUpdateCustomer(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'stripe_update_customer',
      category: 'write_orchestrated',
      annotations: {
        title: 'Update Stripe customer',
        description:
          'Update fields on an existing Stripe customer (email, name, phone, description, metadata). ' +
          'Metadata is merged — pass keys with empty string to clear them. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        customer_id: z
          .string()
          .min(1)
          .describe('Stripe customer ID to update (cus_…).'),
        email: z
          .string()
          .email()
          .optional()
          .describe("New email address for the customer."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("New full name or business name for the customer."),
        phone: z
          .string()
          .optional()
          .describe("New phone number in E.164 format (+15551234567)."),
        description: z
          .string()
          .optional()
          .describe('New internal description for the customer.'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Metadata key-value pairs to merge onto the customer. Pass an empty string value to clear a key.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        customer_id: z.string(),
        updated_fields: z.array(z.string()),
        email: z.string().nullable(),
        name: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        const updatedFields = (['email', 'name', 'phone', 'description', 'metadata'] as const)
          .filter((k) => input[k] !== undefined);

        if (updatedFields.length === 0) {
          throw new Error('At least one field must be provided to update.');
        }

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              customer_id: input.customer_id,
              updated_fields: updatedFields,
              email: input.email ?? null,
              name: input.name ?? null,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would update ${updatedFields.join(', ')} on ${input.customer_id}. Pass dry_run=false to apply.`,
          };
        }

        const upstream = await updateCustomer({
          customerId: input.customer_id,
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
            customer_id: upstream.id ?? input.customer_id,
            updated_fields: updatedFields,
            email: upstream.email ?? null,
            name: upstream.name ?? null,
          },
          audit: { before: null, after: input },
          summary: `Updated Stripe customer ${upstream.id ?? input.customer_id}: ${updatedFields.join(', ')}.`,
        };
      },
    },
    callerHash,
  );
}
