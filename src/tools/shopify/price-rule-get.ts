import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPriceRule } from '../../shopify/full-client.js';

export function registerShopifyPriceRuleGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_price_rule_get',
    category: 'read',
    annotations: {
      title: 'Get a price rule',
      description: 'Retrieve a single price rule by ID via GET /price_rules/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      price_rule_id: z.union([z.string(), z.number()]).describe('Shopify price rule ID.'),
    },
    outputShape: {
      price_rule: z.unknown(),
    },
    handler: async (input, ctx) => {
      const price_rule = await getPriceRule(input.price_rule_id, { correlationId: ctx.correlationId });
      return { data: { price_rule }, summary: `Retrieved price rule ${input.price_rule_id}.` };
    },
  }, callerHash);
}
