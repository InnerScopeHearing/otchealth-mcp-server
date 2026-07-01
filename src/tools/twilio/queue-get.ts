import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getQueue } from '../../twilio/full-client.js';

export function registerTwilioQueueGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_queue_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio queue',
      description: 'Fetches details of a single call queue by SID via GET /Accounts/{SID}/Queues/{QueueSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      queue_sid: z.string().min(1).describe('Twilio Queue SID (starts with QU).'),
    },
    outputShape: {
      sid: z.string(),
      friendly_name: z.string().nullable(),
      current_size: z.number().nullable(),
      max_size: z.number().nullable(),
      average_wait_time: z.number().nullable(),
    },
    handler: async (input) => {
      const q = await getQueue(input.queue_sid);
      return {
        data: {
          sid: q.sid,
          friendly_name: q.friendly_name ?? null,
          current_size: q.current_size ?? null,
          max_size: q.max_size ?? null,
          average_wait_time: q.average_wait_time ?? null,
        },
        summary: `Queue ${q.sid}: ${q.friendly_name ?? '(no name)'}, current_size=${q.current_size}`,
      };
    },
  }, callerHash);
}
