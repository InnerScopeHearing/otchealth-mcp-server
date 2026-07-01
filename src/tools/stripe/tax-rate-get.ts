import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getTaxRate } from '../../stripe/full-client.js';

export function registerStripeTaxRateGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_tax_rate_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe tax rate',
      description: 'Retrieve a single tax rate by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      tax_rate_id: z.string().describe('Tax rate ID (txr_...).'),
    },
    outputShape: {
      id: z.string(),
      display_name: z.string(),
      percentage: z.number(),
      inclusive: z.boolean(),
      active: z.boolean(),
      country: z.string().nullable(),
      jurisdiction: z.string().nullable(),
      description: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const t = await getTaxRate(input.tax_rate_id);
      return {
        data: {
          id: t.id,
          display_name: t.display_name,
          percentage: t.percentage,
          inclusive: t.inclusive,
          active: t.active,
          country: t.country ?? null,
          jurisdiction: t.jurisdiction ?? null,
          description: t.description ?? null,
        },
        summary: `Tax rate ${t.id}: ${t.display_name} ${t.percentage}% (${t.inclusive ? 'inclusive' : 'exclusive'}).`,
      };
    },
  }, callerHash);
}
