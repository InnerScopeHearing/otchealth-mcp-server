import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listWebhooks } from '../../shopify/full-client.js';

export function registerShopifyWebhookList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_webhook_list',
    category: 'read',
    annotations: {
      title: 'List webhooks',
      description: 'Retrieve all registered webhooks via GET /webhooks.json. Filter by topic or endpoint address.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      topic: z.string().optional().describe('Filter by webhook topic, e.g. "orders/create", "products/update".'),
      address: z.string().optional().describe('Filter by endpoint URL.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
    },
    outputShape: {
      webhooks: z.unknown(),
    },
    handler: async (input, ctx) => {
      const webhooks = await listWebhooks(input, { correlationId: ctx.correlationId });
      return { data: { webhooks }, summary: `Listed webhooks.` };
    },
  }, callerHash);
}
