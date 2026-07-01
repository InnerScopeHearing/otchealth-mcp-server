import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getReportingWebhook } from '../../customerio/full-client.js';

export function registerCioReportingWebhookGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_reporting_webhook_get',
    category: 'read',
    annotations: {
      title: 'Get a Customer.io reporting webhook',
      description: 'Fetch full details of a single reporting webhook via App API GET /reporting_webhooks/{id}. Returns the endpoint URL, subscribed event types, and authentication settings.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      webhook_id: z.number().int().positive().describe('Numeric ID of the reporting webhook.'),
    },
    outputShape: {
      reporting_webhook: z.unknown(),
    },
    handler: async (input, ctx) => {
      const reporting_webhook = await getReportingWebhook({ webhook_id: input.webhook_id, correlationId: ctx.correlationId });
      return { data: { reporting_webhook } };
    },
  }, callerHash);
}
