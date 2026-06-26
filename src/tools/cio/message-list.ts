import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMessages } from '../../customerio/full-client.js';

export function registerCioMessageList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_message_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io messages',
      description: 'List messages sent across the workspace via App API GET /messages. Returns delivery records with status, recipient, campaign, and timestamp info.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max messages to return (default 25).'),
      start: z.string().optional().describe('Pagination cursor from a previous response.'),
      type: z.string().optional().describe('Message type filter (e.g. "email", "push", "sms").'),
      campaign_id: z.number().int().positive().optional().describe('Filter messages by campaign ID.'),
    },
    outputShape: {
      messages: z.unknown(),
    },
    handler: async (input, ctx) => {
      const messages = await listMessages({
        limit: input.limit,
        start: input.start,
        type: input.type,
        campaign_id: input.campaign_id,
        correlationId: ctx.correlationId,
      });
      return { data: { messages } };
    },
  }, callerHash);
}
