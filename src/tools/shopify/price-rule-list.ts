import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPriceRules } from '../../shopify/full-client.js';

export function registerShopifyPriceRuleList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_price_rule_list',
    category: 'read',
    annotations: {
      title: 'List price rules',
      description: 'Retrieve price rules (discount definitions) via GET /price_rules.json. Filter by date ranges.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
      starts_at_min: z.string().optional().describe('ISO 8601 min starts_at date.'),
      starts_at_max: z.string().optional().describe('ISO 8601 max starts_at date.'),
      ends_at_min: z.string().optional().describe('ISO 8601 min ends_at date.'),
      ends_at_max: z.string().optional().describe('ISO 8601 max ends_at date.'),
      created_at_min: z.string().optional().describe('ISO 8601 min created date.'),
      created_at_max: z.string().optional().describe('ISO 8601 max created date.'),
    },
    outputShape: {
      price_rules: z.unknown(),
    },
    handler: async (input, ctx) => {
      const price_rules = await listPriceRules(input, { correlationId: ctx.correlationId });
      return { data: { price_rules }, summary: `Listed price rules.` };
    },
  }, callerHash);
}
