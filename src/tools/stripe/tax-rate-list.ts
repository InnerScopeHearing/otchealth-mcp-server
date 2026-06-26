import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTaxRates } from '../../stripe/full-client.js';

export function registerStripeTaxRateList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_tax_rate_list',
    category: 'read',
    annotations: {
      title: 'List Stripe tax rates',
      description: 'List tax rates defined in the Stripe account.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      active: z.boolean().optional().describe('Filter by active status.'),
      inclusive: z.boolean().optional().describe('Filter by inclusive/exclusive.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      tax_rates: z.array(z.object({
        id: z.string(),
        display_name: z.string(),
        percentage: z.number(),
        inclusive: z.boolean(),
        active: z.boolean(),
        country: z.string().nullable(),
        jurisdiction: z.string().nullable(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listTaxRates({
        limit: input.limit ?? 10,
        active: input.active,
        inclusive: input.inclusive,
        starting_after: input.starting_after,
      });
      const tax_rates = (result.data ?? []).map((t: any) => ({
        id: t.id,
        display_name: t.display_name,
        percentage: t.percentage,
        inclusive: t.inclusive,
        active: t.active,
        country: t.country ?? null,
        jurisdiction: t.jurisdiction ?? null,
      }));
      return {
        data: { tax_rates, count: tax_rates.length, has_more: result.has_more ?? false },
        summary: `Found ${tax_rates.length} tax rate(s).`,
      };
    },
  }, callerHash);
}
