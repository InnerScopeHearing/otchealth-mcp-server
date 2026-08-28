/**
 * MCP tool: groundedness_check
 * Calls Azure AI Content Safety Groundedness Detection to identify
 * ungrounded / hallucinated claims in model-generated text relative to
 * a set of supplied source documents.
 *
 * RETIRED PROVIDER (2026-08-28, FND-20260821-e303): src/safety/content-safety.ts's Azure Content
 * Safety call path is permanently disabled (Azure subscription 55c84f6b was deleted 2026-08-13).
 * detectGroundedness() now always returns configured:false / provider:"none (azure retired)" —
 * this tool surface stays wired, but its summary reports that honestly (NOT RUN) instead of the
 * old behavior, which reported "fully grounded" for a check that never happened (a fake pass; see
 * summarizeGroundednessResult below, and content-safety.ts's module doc comment for the full
 * history).
 *
 * Required env vars (historical; read by src/safety/content-safety.ts, no longer consulted):
 *   CONTENT_SAFETY_ENDPOINT
 *   CONTENT_SAFETY_KEY
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { detectGroundedness, type GroundednessResult } from '../../safety/content-safety.js';

/**
 * Pure summary builder, extracted (2026-08-28) so the "did a check actually run" fake-pass bug is
 * unit-testable without any MCP server scaffolding. `configured:false` (today, always — the
 * provider is retired) is reported as an explicit NOT RUN, never as "fully grounded":
 * ungroundedDetected is meaningless when no check happened, and reporting a 0%-ungrounded verdict
 * for a check that never ran is exactly the silent-failure shape FND-20260821-e303 exists to
 * close.
 */
export function summarizeGroundednessResult(result: GroundednessResult): string {
  if (!result.configured) {
    return `Groundedness: NOT RUN — no content-safety provider (${result.provider}). This is not a check verdict.`;
  }
  const pct = (result.ungroundedPercentage * 100).toFixed(1);
  return result.ungroundedDetected
    ? `Groundedness: ungrounded content DETECTED (${pct}% ungrounded)`
    : `Groundedness: fully grounded (${pct}% ungrounded)`;
}

export function registerGroundednessCheck(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'groundedness_check',
      category: 'read',
      annotations: {
        title: 'Groundedness Detection — hallucination scan',
        description:
          'Runs Azure AI Content Safety Groundedness Detection to measure how much of the supplied text is unsupported by the provided grounding sources. Returns ungroundedDetected=true and an ungroundedPercentage when hallucinations are found. The provider is currently RETIRED (Azure subscription permanently deleted) — every call returns configured=false and a NOT RUN summary rather than a fake fully-grounded/ungrounded verdict; see `provider`. Read-only; never mutates data.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        query: z
          .string()
          .describe('The original question or user query that the text is answering.'),
        text: z
          .string()
          .describe('The model-generated answer or completion to evaluate for groundedness.'),
        groundingSources: z
          .array(z.string())
          .describe(
            'One or more source documents that should support the claims made in `text`. Provide the full text of each relevant passage.',
          ),
      },
      outputShape: {
        configured: z.boolean(),
        ungroundedDetected: z.boolean(),
        ungroundedPercentage: z.number(),
        provider: z.string(),
        raw: z.unknown(),
      },
      handler: async (input) => {
        const result = await detectGroundedness(
          input.query,
          input.text,
          input.groundingSources,
        );
        return { data: result, summary: summarizeGroundednessResult(result) };
      },
    },
    callerHash,
  );
}
