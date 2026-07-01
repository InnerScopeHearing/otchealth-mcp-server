import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCallFeedback } from '../../twilio/full-client.js';

export function registerTwilioCallFeedbackGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_call_feedback_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio call feedback',
      description: 'Fetches quality feedback for a specific call via GET /Accounts/{SID}/Calls/{CallSid}/Feedback.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      call_sid: z.string().min(1).describe('Twilio Call SID (starts with CA).'),
    },
    outputShape: {
      call_sid: z.string().nullable(),
      quality_score: z.number().nullable(),
      issues: z.array(z.string()),
    },
    handler: async (input) => {
      const fb = await getCallFeedback(input.call_sid);
      return {
        data: {
          call_sid: fb.call_sid ?? null,
          quality_score: fb.quality_score ?? null,
          issues: fb.issues ?? [],
        },
        summary: `Call feedback for ${input.call_sid}: quality_score=${fb.quality_score ?? 'none'}`,
      };
    },
  }, callerHash);
}
