import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCallFeedback } from '../../twilio/full-client.js';

export function registerTwilioCallFeedbackCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_call_feedback_create',
    category: 'write_simple',
    annotations: {
      title: 'Submit Twilio call quality feedback',
      description: 'Submits a quality score and optional issue tags for a call via POST /Accounts/{SID}/Calls/{CallSid}/Feedback.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      call_sid: z.string().min(1).describe('Twilio Call SID (starts with CA).'),
      quality_score: z.number().int().min(1).max(5).describe('Call quality score from 1 (worst) to 5 (best).'),
      issue: z.array(z.string()).optional().describe('Issue labels, e.g. ["imperfect-audio", "post-dial-delay"]. See Twilio docs for valid values.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      call_sid: z.string(),
      quality_score: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, call_sid: input.call_sid, quality_score: input.quality_score },
          audit: { before: null, after: input },
          summary: `DRY RUN: would submit quality_score=${input.quality_score} for call ${input.call_sid}. Pass dry_run=false to apply.`,
        };
      }
      const result = await createCallFeedback(input.call_sid, {
        quality_score: input.quality_score,
        issue: input.issue,
      });
      return {
        data: { executed: true, dry_run: false, call_sid: result.call_sid ?? input.call_sid, quality_score: result.quality_score ?? input.quality_score },
        audit: { before: null, after: input },
        summary: `Submitted feedback for call ${input.call_sid}: quality_score=${input.quality_score}.`,
      };
    },
  }, callerHash);
}
