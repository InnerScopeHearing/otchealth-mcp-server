import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCallRecordings } from '../../twilio/full-client.js';

export function registerTwilioCallListRecordings(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_call_list_recordings',
    category: 'read',
    annotations: {
      title: 'List recordings for a Twilio call',
      description: 'Lists all recordings attached to a specific call via GET /Accounts/{SID}/Calls/{CallSid}/Recordings.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      call_sid: z.string().min(1).describe('Twilio Call SID (starts with CA).'),
    },
    outputShape: {
      recordings: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const recordings = await listCallRecordings(input.call_sid);
      return {
        data: { recordings, count: recordings.length },
        summary: `Found ${recordings.length} recording(s) for call ${input.call_sid}.`,
      };
    },
  }, callerHash);
}
