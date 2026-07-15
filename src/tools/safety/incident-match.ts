/**
 * MCP tool: incident_match — "you have been here before." Give it free text describing what is
 * happening right now (an error, a plan, a symptom) and it semantically searches the shared brain
 * (memory-exec) for the single most similar PAST pitfall or correction, if one clears a confidence
 * threshold. Advisory recall, not a gate: no match is a normal, successful result, never an error.
 *
 * Thin wrapper around safety/incident-match.ts (the pure decision core + fail-open IO shell) --
 * mirrors tools/safety/shield-check.ts's shape (a `read` tool that is a thin pass-through to a
 * safety/ module).
 *
 * FAST-FOLLOW (documented, intentionally NOT done this pass): wiring matchIncident() into the
 * shared hot mutation path (registry.ts, alongside jit-doctrine's evaluateJitDoctrine call) so a
 * match rides along AUTOMATICALLY on a risky tool call instead of requiring an explicit ask. This
 * pass ships incident_match as a STANDALONE, explicitly-invoked tool only, so its behavior can be
 * proven out before it starts touching every mutating call the way jit-doctrine does today.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { evaluateIncidentMatch } from '../../safety/incident-match.js';

export function registerIncidentMatch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'incident_match',
      category: 'read',
      annotations: {
        title: 'Incident match: have we been here before?',
        description:
          'Semantic "you have been here before" recall. Give it free text describing what is happening right now (an error, a plan, a risky action) and it searches the shared brain (memory-exec) for the single most similar PAST pitfall or correction, if any. Returns matched=false (never an error) when nothing clears the confidence threshold -- a miss is a normal result, not a failure. Read-only, advisory only; it never blocks anything. INCIDENT_MATCH_MODE=off disables it fleet-wide without a redeploy.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        text: z
          .string()
          .min(1)
          .describe('Free text describing the current situation, error, or planned action to check against past incidents.'),
      },
      outputShape: {
        matched: z.boolean(),
        incident: z
          .object({
            text: z.string(),
            type: z.string().optional(),
            score: z.number(),
            id: z.string().optional(),
            path: z.string().optional(),
            agent: z.string().optional(),
          })
          .nullable(),
        mode: z.string(),
        already_surfaced: z.boolean().optional(),
      },
      handler: async (input, ctx) => {
        const outcome = await evaluateIncidentMatch(ctx.callerHash, input.text);
        if (!outcome.match) {
          return {
            data: { matched: false, incident: null, mode: outcome.mode },
            summary:
              outcome.mode === 'off'
                ? 'incident_match is disabled (INCIDENT_MATCH_MODE=off).'
                : 'No similar past incident found above the confidence threshold.',
          };
        }
        const { text, type, score, id, path, agent } = outcome.match;
        return {
          data: {
            matched: true,
            incident: { text, type, score, id, path, agent },
            mode: outcome.mode,
            already_surfaced: outcome.already_surfaced ?? false,
          },
          summary:
            `Match (score ${score.toFixed(2)}${type ? `, ${type}` : ''}${agent ? `, from ${agent}` : ''}): ${text}` +
            (outcome.already_surfaced ? ' You were already shown this incident earlier in this session.' : ''),
        };
      },
    },
    callerHash,
  );
}
