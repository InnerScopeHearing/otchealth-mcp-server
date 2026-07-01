import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteWebhook } from '../../shopify/full-client.js';

export function registerShopifyWebhookDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_webhook_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a webhook',
      description: 'Permanently delete a webhook registration via DELETE /webhooks/{id}.json. Shopify will stop sending events to the endpoint. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      webhook_id: z.union([z.string(), z.number()]).describe('Shopify webhook ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_webhook_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_webhook_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete webhook ${input.webhook_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteWebhook(input.webhook_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_webhook_id: input.webhook_id },
        audit: { before: null, after: input },
        summary: `Webhook ${input.webhook_id} deleted.`,
      };
    },
  }, callerHash);
}
