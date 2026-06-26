import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listReportingWebhooks } from '../../customerio/full-client.js';

export function registerCioReportingWebhookList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_reporting_webhook_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io reporting webhooks',
      description: 'List all reporting webhooks configured in the workspace via App API GET /reporting_webhooks. Returns webhook IDs, endpoint URLs, and the event types they subscribe to.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      reporting_webhooks: z.unknown(),
    },
    handler: async (_input, ctx) => {
      const reporting_webhooks = await listReportingWebhooks({ correlationId: ctx.correlationId });
      return { data: { reporting_webhooks } };
    },
  }, callerHash);
}
