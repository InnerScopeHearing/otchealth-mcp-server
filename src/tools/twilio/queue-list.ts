import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listQueues } from '../../twilio/full-client.js';

export function registerTwilioQueueList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_queue_list',
    category: 'read',
    annotations: {
      title: 'List Twilio queues',
      description: 'Lists call queues on the account via GET /Accounts/{SID}/Queues.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 20, max 100).'),
    },
    outputShape: {
      queues: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const queues = await listQueues(input.page_size);
      return {
        data: { queues, count: queues.length },
        summary: `Found ${queues.length} queue(s).`,
      };
    },
  }, callerHash);
}
