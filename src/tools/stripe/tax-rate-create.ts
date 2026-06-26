import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createTaxRate } from '../../stripe/full-client.js';

export function registerStripeTaxRateCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_tax_rate_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Stripe tax rate',
      description: 'Create a new tax rate for use on invoices and subscriptions. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      display_name: z.string().describe('Display name shown on invoices (e.g. VAT, GST).'),
      percentage: z.number().min(0).max(100).describe('Tax percentage (e.g. 20 for 20%).'),
      inclusive: z.boolean().describe('If true, tax is included in the price. If false, added on top.'),
      active: z.boolean().optional().describe('Whether this rate is active (default true).'),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code.'),
      description: z.string().optional().describe('Internal description.'),
      jurisdiction: z.string().optional().describe('Jurisdiction (e.g. CA, DE).'),
      state: z.string().optional().describe('US state code (e.g. CA).'),
      tax_type: z.string().optional().describe('Stripe tax type code.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      tax_rate_id: z.string().nullable(),
      percentage: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, tax_rate_id: null, percentage: input.percentage },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create tax rate ${input.display_name} ${input.percentage}%. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createTaxRate({
        display_name: input.display_name,
        percentage: input.percentage,
        inclusive: input.inclusive,
        active: input.active,
        country: input.country,
        description: input.description,
        jurisdiction: input.jurisdiction,
        state: input.state,
        tax_type: input.tax_type,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, tax_rate_id: upstream.id, percentage: upstream.percentage },
        audit: { before: null, after: input },
        summary: `Created tax rate ${upstream.id}: ${upstream.display_name} ${upstream.percentage}%.`,
      };
    },
  }, callerHash);
}
