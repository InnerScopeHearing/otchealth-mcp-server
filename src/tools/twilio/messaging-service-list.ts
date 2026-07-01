import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMessagingServices } from '../../twilio/full-client.js';

export function registerTwilioMessagingServiceList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_messaging_service_list',
    category: 'read',
    annotations: {
      title: 'List Twilio Messaging Services',
      description: 'Lists all Messaging Services on the account via GET /Accounts/{SID}/Services.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 20, max 100).'),
    },
    outputShape: {
      services: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const services = await listMessagingServices(input.page_size);
      return {
        data: { services, count: services.length },
        summary: `Found ${services.length} Messaging Service(s).`,
      };
    },
  }, callerHash);
}
