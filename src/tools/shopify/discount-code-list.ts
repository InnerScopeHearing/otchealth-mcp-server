import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listDiscountCodes } from '../../shopify/full-client.js';

export function registerShopifyDiscountCodeList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_discount_code_list',
    category: 'read',
    annotations: {
      title: 'List discount codes for a price rule',
      description: 'Retrieve all discount codes for a given price rule via GET /price_rules/{id}/discount_codes.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      price_rule_id: z.union([z.string(), z.number()]).describe('Shopify price rule ID.'),
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
    },
    outputShape: {
      discount_codes: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { price_rule_id, ...params } = input;
      const discount_codes = await listDiscountCodes(price_rule_id, params, { correlationId: ctx.correlationId });
      return { data: { discount_codes }, summary: `Listed discount codes for price rule ${price_rule_id}.` };
    },
  }, callerHash);
}
