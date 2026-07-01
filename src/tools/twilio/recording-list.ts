import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listRecordings } from '../../twilio/full-client.js';

export function registerTwilioRecordingList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_recording_list',
    category: 'read',
    annotations: {
      title: 'List Twilio recordings',
      description: 'Lists account-level call recordings via GET /Accounts/{SID}/Recordings.json with optional call_sid filter. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      call_sid: z.string().optional().describe('Filter recordings to a specific Call SID.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 20, max 100).'),
    },
    outputShape: {
      recordings: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const recordings = await listRecordings(input);
      return {
        data: { recordings, count: recordings.length },
        summary: `Found ${recordings.length} recording(s).`,
      };
    },
  }, callerHash);
}
