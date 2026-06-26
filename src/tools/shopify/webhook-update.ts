import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateWebhook } from '../../shopify/full-client.js';

export function registerShopifyWebhookUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_webhook_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a webhook',
      description: 'Update the endpoint address or field filters of an existing webhook via PUT /webhooks/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      webhook_id: z.union([z.string(), z.number()]).describe('Shopify webhook ID to update.'),
      address: z.string().url().optional().describe('New HTTPS endpoint URL.'),
      fields: z.array(z.string()).optional().describe('New subset of fields to include.'),
      metafield_namespaces: z.array(z.string()).optional().describe('New metafield namespaces to include.'),
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
          summary: `DRY RUN: would update webhook ${input.webhook_id}. Pass dry_run=false to apply.`,
        };
      }
      const { webhook_id, ...patch } = input;
      const webhook = await updateWebhook(webhook_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, webhook },
        audit: { before: null, after: input },
        summary: `Webhook ${webhook_id} updated.`,
      };
    },
  }, callerHash);
}
