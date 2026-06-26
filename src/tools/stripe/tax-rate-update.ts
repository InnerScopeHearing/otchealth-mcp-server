import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateTaxRate } from '../../stripe/full-client.js';

export function registerStripeTaxRateUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_tax_rate_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Stripe tax rate',
      description: 'Update active status, display name, description, or metadata on a tax rate. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      tax_rate_id: z.string().describe('Tax rate ID (txr_...) to update.'),
      active: z.boolean().optional().describe('Enable or disable the tax rate.'),
      display_name: z.string().optional().describe('New display name.'),
      description: z.string().optional().describe('New description.'),
      jurisdiction: z.string().optional().describe('Jurisdiction.'),
      tax_type: z.string().optional().describe('Stripe tax type code.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      tax_rate_id: z.string().nullable(),
      active: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, tax_rate_id: input.tax_rate_id, active: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update tax rate ${input.tax_rate_id}. Pass dry_run=false to apply.`,
        };
      }
      const { tax_rate_id, ...params } = input;
      const upstream = await updateTaxRate(tax_rate_id, params);
      return {
        data: { executed: true, dry_run: false, tax_rate_id: upstream.id, active: upstream.active },
        audit: { before: null, after: input },
        summary: `Updated tax rate ${upstream.id} (active: ${upstream.active}).`,
      };
    },
  }, callerHash);
}
