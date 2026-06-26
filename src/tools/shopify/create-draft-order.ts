import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shopifyRestWrite } from '../../shopify/client.js';

export function registerShopifyCreateDraftOrder(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shopify_create_draft_order',
      category: 'write_simple',
      annotations: {
        title: 'Shopify: create draft order',
        description: 'Create a DRAFT order (a quote/cart that does NOT charge anyone) — useful for assisted sales, custom offers, or sending an invoice link. Does not capture payment. Honors dry_run (plan-only by default).',
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      },
      inputShape: {
        line_items: z.array(z.object({ variant_id: z.union([z.string(), z.number()]).optional(), title: z.string().optional(), price: z.string().optional(), quantity: z.number().int().min(1) })).min(1),
        customer_email: z.string().optional(),
        note: z.string().optional(),
        discount_code: z.string().optional().describe('e.g. PAIR99 — applied as a custom discount label.'),
      },
      outputShape: { draft_order: z.unknown().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        const draft_order: Record<string, unknown> = { line_items: input.line_items };
        if (input.customer_email) draft_order.email = input.customer_email;
        if (input.note) draft_order.note = input.note;
        if (input.discount_code) draft_order.applied_discount = { title: input.discount_code, value_type: 'percentage', value: '0', description: input.discount_code };
        if (ctx.dryRun) return { data: { planned: true }, summary: `DRY RUN: would create a draft order with ${input.line_items.length} line item(s)${input.customer_email ? ` for ${input.customer_email}` : ''}. No charge. Pass dry_run=false to execute.` };
        const r = await shopifyRestWrite<{ draft_order?: { id?: number; invoice_url?: string } }>('POST', `/draft_orders.json`, { draft_order }, { correlationId: ctx.correlationId });
        return { data: { draft_order: r.draft_order }, summary: `Created draft order ${r.draft_order?.id}${r.draft_order?.invoice_url ? ` (invoice: ${r.draft_order.invoice_url})` : ''}. No payment captured.`, audit: { after: r.draft_order } };
      },
    },
    callerHash,
  );
}
