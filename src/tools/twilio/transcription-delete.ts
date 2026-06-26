import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteTranscription } from '../../twilio/full-client.js';

export function registerTwilioTranscriptionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_transcription_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Twilio transcription',
      description: 'Permanently deletes a transcription record by SID via DELETE /Accounts/{SID}/Transcriptions/{TranscriptionSid}.json. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      transcription_sid: z.string().min(1).describe('Twilio Transcription SID to delete (starts with TR).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      transcription_sid: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, transcription_sid: input.transcription_sid },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete transcription ${input.transcription_sid}. Pass dry_run=false to apply.`,
        };
      }
      await deleteTranscription(input.transcription_sid);
      return {
        data: { executed: true, dry_run: false, transcription_sid: input.transcription_sid },
        audit: { before: { transcription_sid: input.transcription_sid }, after: null },
        summary: `Deleted transcription ${input.transcription_sid}.`,
      };
    },
  }, callerHash);
}
