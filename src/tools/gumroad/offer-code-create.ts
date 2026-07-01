import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createOfferCode } from '../../gumroad/full-client.js';

export function registerGumroadOfferCodeCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_offer_code_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Gumroad offer code',
      description: 'Create a discount/offer code for a Gumroad product. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      name: z.string().describe('Offer code string (e.g. "SAVE20"). Case-insensitive.'),
      amount_off: z.number().describe('Discount amount — cents if offer_type=cents, percentage points if offer_type=percent.'),
      offer_type: z.enum(['cents', 'percent']).optional().default('percent').describe('Type of discount: "percent" (default) or "cents".'),
      max_purchase_count: z.number().int().optional().describe('Maximum number of redemptions. Omit for unlimited.'),
      universal: z.boolean().optional().describe('If true, offer code applies to all products (not just this product_id).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      offer_code: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create offer code "${input.name}" (${input.amount_off} ${input.offer_type ?? 'percent'} off) on product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await createOfferCode(input.product_id, {
        name: input.name,
        amount_off: input.amount_off,
        offer_type: input.offer_type as 'cents' | 'percent' | undefined,
        max_purchase_count: input.max_purchase_count,
        universal: input.universal,
      });
      return {
        data: { executed: true, dry_run: false, offer_code: resp.offer_code ?? resp },
        audit: { before: null, after: input },
        summary: `Created offer code "${input.name}" on product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
