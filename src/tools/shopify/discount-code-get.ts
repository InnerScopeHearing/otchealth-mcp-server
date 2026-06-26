import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDiscountCode } from '../../shopify/full-client.js';

export function registerShopifyDiscountCodeGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_discount_code_get',
    category: 'read',
    annotations: {
      title: 'Get a discount code',
      description: 'Retrieve a single discount code by price rule ID and discount code ID via GET /price_rules/{id}/discount_codes/{code_id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      price_rule_id: z.union([z.string(), z.number()]).describe('Shopify price rule ID.'),
      discount_code_id: z.union([z.string(), z.number()]).describe('Shopify discount code ID.'),
    },
    outputShape: {
      discount_code: z.unknown(),
    },
    handler: async (input, ctx) => {
      const discount_code = await getDiscountCode(input.price_rule_id, input.discount_code_id, { correlationId: ctx.correlationId });
      return { data: { discount_code }, summary: `Retrieved discount code ${input.discount_code_id}.` };
    },
  }, callerHash);
}
