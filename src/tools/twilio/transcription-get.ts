import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getTranscription } from '../../twilio/full-client.js';

export function registerTwilioTranscriptionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_transcription_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio transcription',
      description: 'Fetches a single call transcription by SID via GET /Accounts/{SID}/Transcriptions/{TranscriptionSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      transcription_sid: z.string().min(1).describe('Twilio Transcription SID (starts with TR).'),
    },
    outputShape: {
      sid: z.string(),
      status: z.string().nullable(),
      transcription_text: z.string().nullable(),
      recording_sid: z.string().nullable(),
      duration: z.string().nullable(),
    },
    handler: async (input) => {
      const tr = await getTranscription(input.transcription_sid);
      return {
        data: {
          sid: tr.sid,
          status: tr.status ?? null,
          transcription_text: tr.transcription_text ?? null,
          recording_sid: tr.recording_sid ?? null,
          duration: tr.duration ?? null,
        },
        summary: `Transcription ${tr.sid}: status=${tr.status}`,
      };
    },
  }, callerHash);
}
