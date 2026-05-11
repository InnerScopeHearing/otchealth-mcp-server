import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shopifyRestGet } from '../../shopify/client.js';

interface CheckoutsResponse {
  checkouts?: Array<{
    id: number;
    token?: string;
    cart_token?: string;
    email?: string;
    completed_at?: string | null;
    created_at?: string;
    updated_at?: string;
    abandoned_checkout_url?: string;
    total_price?: string;
    currency?: string;
    line_items?: Array<{ title?: string; quantity?: number; price?: string; product_id?: number; variant_id?: number }>;
  }>;
}

export function registerShopifyListAbandonedCheckouts(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_list_abandoned_checkouts',
      category: 'read',
      annotations: {
        title: 'List Shopify abandoned checkouts',
        description:
          'List recent abandoned checkouts on hearingassist.myshopify.com. Returns email, total price, recovery URL, line items, timestamps. Recovery URL is the link the customer clicks to resume the checkout.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        limit: z.number().int().min(1).max(250).optional(),
        status: z.enum(['open', 'closed', 'any']).optional().describe('Default open.'),
        created_at_min: z
          .string()
          .optional()
          .describe('ISO-8601 datetime — only checkouts created on/after this time.'),
        created_at_max: z.string().optional(),
        since_id: z.number().int().optional(),
      },
      outputShape: {
        checkouts: z.array(z.unknown()),
        count: z.number(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {
          limit: input.limit ?? 50,
          status: input.status ?? 'open',
          created_at_min: input.created_at_min,
          created_at_max: input.created_at_max,
          since_id: input.since_id,
        };
        const data = await shopifyRestGet<CheckoutsResponse>('/checkouts.json', {
          query,
          correlationId: ctx.correlationId,
        });
        const checkouts = data.checkouts ?? [];
        return {
          data: { checkouts, count: checkouts.length },
          summary: `Found ${checkouts.length} abandoned checkout(s).`,
        };
      },
    },
    callerHash,
  );
}
