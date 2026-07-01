import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getWebhook } from '../../shopify/full-client.js';

export function registerShopifyWebhookGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_webhook_get',
    category: 'read',
    annotations: {
      title: 'Get a webhook',
      description: 'Retrieve a single webhook by ID via GET /webhooks/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      webhook_id: z.union([z.string(), z.number()]).describe('Shopify webhook ID.'),
    },
    outputShape: {
      webhook: z.unknown(),
    },
    handler: async (input, ctx) => {
      const webhook = await getWebhook(input.webhook_id, { correlationId: ctx.correlationId });
      return { data: { webhook }, summary: `Retrieved webhook ${input.webhook_id}.` };
    },
  }, callerHash);
}
