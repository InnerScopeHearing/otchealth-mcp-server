import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shopifyRestGet } from '../../shopify/client.js';

export function registerShopifyGetOrder(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shopify_get_order',
      category: 'read',
      annotations: {
        title: 'Get a Shopify order',
        description:
          'Fetch a single order by id. Returns line items, customer ref, financial/fulfillment status, totals, shipping address (PII subject to log redaction), and timestamps.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        order_id: z.union([z.string(), z.number()]),
        fields: z.string().optional().describe('Comma-separated subset of fields to return.'),
      },
      outputShape: {
        order: z.unknown(),
      },
      handler: async (input, ctx) => {
        const id = encodeURIComponent(String(input.order_id));
        const query: Record<string, string | number | undefined> = {};
        if (input.fields !== undefined) query.fields = input.fields;
        const data = await shopifyRestGet<{ order?: unknown }>(`/orders/${id}.json`, {
          query,
          correlationId: ctx.correlationId,
        });
        return { data: { order: data.order ?? null } };
      },
    },
    callerHash,
  );
}
