import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTranscriptions } from '../../twilio/full-client.js';

export function registerTwilioTranscriptionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_transcription_list',
    category: 'read',
    annotations: {
      title: 'List Twilio transcriptions',
      description: 'Lists call transcriptions on the account via GET /Accounts/{SID}/Transcriptions.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 20, max 100).'),
    },
    outputShape: {
      transcriptions: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const transcriptions = await listTranscriptions(input.page_size);
      return {
        data: { transcriptions, count: transcriptions.length },
        summary: `Found ${transcriptions.length} transcription(s).`,
      };
    },
  }, callerHash);
}
