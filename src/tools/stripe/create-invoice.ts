/**
 * stripe_create_invoice — POST /v1/invoices
 *
 * Category: write_orchestrated (creates a financial document; if auto_advance=true Stripe
 * will automatically finalize and attempt collection — direct money movement).
 * CFO/CTO scope for approval.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createInvoice } from '../../stripe/write-client.js';

export function registerStripeCreateInvoice(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'stripe_create_invoice',
      category: 'write_orchestrated',
      annotations: {
        title: 'Create Stripe invoice',
        description:
          'Create a draft invoice for an existing Stripe customer. The invoice is created in draft ' +
          'state by default (auto_advance=false) so you can add line items before Stripe finalizes and ' +
          'attempts collection. Set auto_advance=true to let Stripe auto-finalize. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        customer: z
          .string()
          .min(1)
          .describe('Stripe customer ID to create the invoice for (cus_…).'),
        collection_method: z
          .enum(['charge_automatically', 'send_invoice'])
          .optional()
          .describe(
            '"charge_automatically" charges the default payment method on file; ' +
            '"send_invoice" emails the invoice PDF. Default: charge_automatically.',
          ),
        days_until_due: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Days until invoice is due (only relevant for send_invoice collection method).'),
        description: z
          .string()
          .optional()
          .describe('Optional memo/description shown on the invoice.'),
        auto_advance: z
          .boolean()
          .optional()
          .describe(
            'If true, Stripe automatically finalizes and attempts collection after 1 hour. ' +
            'Default false — leaves invoice in draft so you can add line items first.',
          ),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Key-value metadata to attach to the invoice (max 50 keys).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        invoice_id: z.string().nullable(),
        customer: z.string().nullable(),
        status: z.string().nullable(),
        collection_method: z.string().nullable(),
        auto_advance: z.boolean().nullable(),
        amount_due_cents: z.number().nullable(),
        created: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              invoice_id: null,
              customer: input.customer,
              status: 'draft',
              collection_method: input.collection_method ?? 'charge_automatically',
              auto_advance: input.auto_advance ?? false,
              amount_due_cents: null,
              created: null,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create ${input.auto_advance ? 'auto-advancing' : 'draft'} invoice for customer ${input.customer}. Pass dry_run=false to apply.`,
          };
        }

        const upstream = await createInvoice({
          customer: input.customer,
          collection_method: input.collection_method,
          days_until_due: input.days_until_due,
          description: input.description,
          auto_advance: input.auto_advance,
          metadata: input.metadata,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            invoice_id: upstream.id ?? null,
            customer: upstream.customer ?? null,
            status: upstream.status ?? null,
            collection_method: upstream.collection_method ?? null,
            auto_advance: upstream.auto_advance ?? null,
            amount_due_cents: upstream.amount_due ?? null,
            created: upstream.created
              ? new Date(upstream.created * 1000).toISOString()
              : null,
          },
          audit: { before: null, after: input },
          summary: `Created invoice ${upstream.id} for customer ${upstream.customer} — status: ${upstream.status}.`,
        };
      },
    },
    callerHash,
  );
}
