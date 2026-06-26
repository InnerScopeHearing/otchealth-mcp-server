import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCalls } from '../../twilio/full-client.js';

export function registerTwilioCallList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_call_list',
    category: 'read',
    annotations: {
      title: 'List Twilio calls',
      description: 'Lists call records for the account via GET /Accounts/{SID}/Calls.json with optional filters. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      to: z.string().optional().describe('Filter by destination phone number (E.164).'),
      from: z.string().optional().describe('Filter by originating phone number (E.164).'),
      status: z.string().optional().describe('Filter by call status: queued, ringing, in-progress, canceled, completed, failed, busy, no-answer.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results to return (default 20, max 100).'),
    },
    outputShape: {
      calls: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const calls = await listCalls(input);
      return {
        data: { calls, count: calls.length },
        summary: `Found ${calls.length} call(s).`,
      };
    },
  }, callerHash);
}
