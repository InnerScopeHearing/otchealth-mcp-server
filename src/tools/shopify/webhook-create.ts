import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createWebhook } from '../../shopify/full-client.js';

export function registerShopifyWebhookCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_webhook_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a webhook',
      description: 'Register a new webhook endpoint via POST /webhooks.json. Shopify will POST events to the given address for the specified topic. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      topic: z.string().min(1).describe('Shopify event topic, e.g. "orders/create", "products/update", "customers/delete". See Shopify docs for full list.'),
      address: z.string().url().describe('HTTPS endpoint URL where Shopify will POST event payloads.'),
      format: z.enum(['json', 'xml']).optional().default('json').describe('Payload format (default: json).'),
      fields: z.array(z.string()).optional().describe('Subset of fields to include in webhook payloads.'),
      metafield_namespaces: z.array(z.string()).optional().describe('Metafield namespaces to include in webhooks.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      webhook: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, webhook: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would register webhook for topic "${input.topic}" to ${input.address}. Pass dry_run=false to apply.`,
        };
      }
      const webhook = await createWebhook(input, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, webhook },
        audit: { before: null, after: input },
        summary: `Webhook created for topic "${input.topic}".`,
      };
    },
  }, callerHash);
}
