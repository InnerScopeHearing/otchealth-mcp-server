import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listIncomingPhoneNumbers } from '../../twilio/full-client.js';

export function registerTwilioNumberList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_number_list',
    category: 'read',
    annotations: {
      title: 'List Twilio incoming phone numbers',
      description: 'Lists all phone numbers purchased/owned by this Twilio account via GET /Accounts/{SID}/IncomingPhoneNumbers.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      phone_number: z.string().optional().describe('Filter by phone number (E.164 or partial).'),
      friendly_name: z.string().optional().describe('Filter by friendly name.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 20, max 100).'),
    },
    outputShape: {
      phone_numbers: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const numbers = await listIncomingPhoneNumbers(input);
      return {
        data: { phone_numbers: numbers, count: numbers.length },
        summary: `Found ${numbers.length} owned phone number(s).`,
      };
    },
  }, callerHash);
}
