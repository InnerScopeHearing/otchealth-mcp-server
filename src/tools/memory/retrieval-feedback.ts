/**
 * retrieval_feedback -- the OPT-IN reporting half of the production feedback loop (Wave 7 item 7.1).
 * A caller that acted on (or ignored) a hit returned by brain_search / kb_search reports back with
 * the hit's `feedback_ref` token plus a rating, so retrieval-quality signal accumulates over real
 * usage instead of only the static eval suites. See memory/retrieval-feedback.ts for the full design
 * (why a self-describing ref, why PostHog, the fail-open contract).
 *
 * FOUNDATION ONLY: this tool makes feedback CAPTURABLE and durably stored. It does not read it back,
 * aggregate it, or feed it into ranking -- that is a deliberate, separate follow-on (see this file's
 * and retrieval-feedback.ts's headers). Calling this tool changes zero retrieval behavior.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import {
  FEEDBACK_RATINGS,
  parseFeedbackRef,
  isFeedbackRefFresh,
  recordRetrievalFeedback,
} from '../../memory/retrieval-feedback.js';

export function registerRetrievalFeedback(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'retrieval_feedback',
      category: 'write_simple',
      annotations: {
        title: 'Report feedback on a brain_search / kb_search hit',
        description:
          'OPT-IN: report whether a specific hit from a prior brain_search or kb_search call was actually useful. Pass the `feedback_ref` token that call attached to the hit (never construct one by hand) plus a rating: "useful" (you acted on it), "not_useful" (noise/irrelevant), or "cited" (you directly quoted/referenced it in a downstream answer or action). No need to re-send the hit content or the original query, the ref already carries what is needed. Best-effort and fire-and-forget: this never blocks, never fails loudly, and changes zero retrieval behavior on its own, it only accumulates signal for a future retrieval-quality pass. Nothing requires you to call this; skip it freely.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: {
        feedback_ref: z
          .string()
          .min(1)
          .describe('The feedback_ref value from a brain_search or kb_search hit. Opaque; copy it verbatim, do not construct or edit it.'),
        rating: z.enum(FEEDBACK_RATINGS).describe('useful | not_useful | cited.'),
        reason: z
          .string()
          .max(2000)
          .optional()
          .describe('Optional free-text reason (capped ~300 chars server-side; any secret-shaped text is redacted before storage).'),
      },
      outputShape: {
        recorded: z.boolean(),
        ref: z
          .object({
            tool: z.string(),
            room: z.string(),
            hit_id: z.string(),
            query: z.string(),
            issued_at: z.string(),
            fresh: z.boolean(),
          })
          .optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const parsed = parseFeedbackRef(input.feedback_ref);
        if (!parsed) {
          return {
            data: { recorded: false, error: 'invalid_reference' },
            summary:
              'That feedback_ref could not be decoded (malformed, hand-edited, or from a build predating this tool). No feedback was recorded.',
          };
        }
        const refSummary = {
          tool: parsed.tool,
          room: parsed.room,
          hit_id: parsed.hitId,
          query: parsed.query,
          issued_at: new Date(parsed.ts).toISOString(),
          fresh: isFeedbackRefFresh(parsed),
        };

        if (ctx.dryRun) {
          return {
            data: { recorded: false, ref: refSummary, note: 'dry_run: nothing recorded. Pass dry_run=false to record.' },
            summary: `DRY RUN: would record "${input.rating}" feedback for a ${parsed.tool} hit in "${parsed.room}". Pass dry_run=false to record.`,
          };
        }

        // Fire-and-forget: recordRetrievalFeedback is synchronous and fail-open by construction
        // (memory/retrieval-feedback.ts), so this can never add latency to, or fail, this response.
        recordRetrievalFeedback({ ref: parsed, rating: input.rating, reason: input.reason, caller: ctx.callerAgent });

        return {
          data: { recorded: true, ref: refSummary },
          summary: `Recorded "${input.rating}" feedback for a ${parsed.tool} hit in "${parsed.room}"${refSummary.fresh ? '' : ' (aged reference)'}.`,
          audit: { after: { rating: input.rating, tool: parsed.tool, room: parsed.room } },
        };
      },
    },
    callerHash,
  );
}
