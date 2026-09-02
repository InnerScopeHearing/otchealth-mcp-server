/**
 * MCP tool: groundedness_check
 * Identifies ungrounded / hallucinated claims in model-generated text relative to a set of
 * supplied source documents.
 *
 * PROVIDER (2026-08-29): Amazon Bedrock Guardrails' Contextual Grounding check is now a real, live
 * provider behind this tool (src/safety/bedrock-guardrails.ts), selected when
 * GUARDRAIL_PROVIDER=bedrock and BEDROCK_GUARDRAIL_ID are both set. When Bedrock is not selected,
 * this tool falls through BYTE-FOR-BYTE to the legacy path: src/safety/content-safety.ts's Azure
 * AI Content Safety call path stays PERMANENTLY RETIRED (2026-08-28, FND-20260821-e303 — Azure
 * subscription 55c84f6b was deleted 2026-08-13), so detectGroundedness() there always returns
 * configured:false / provider:"none (azure retired)". Either way, summarizeGroundednessResult
 * below reports the true state honestly: NOT RUN when no provider is configured, an explicit
 * ERROR when a configured provider was called but failed, or a real fully-grounded/ungrounded
 * verdict — never a fake pass (see summarizeGroundednessResult's own doc comment, and
 * content-safety.ts's module doc comment for the original incident this all traces back to).
 *
 * Required env vars for the Bedrock path (see bedrock-guardrails.ts for the full contract):
 *   GUARDRAIL_PROVIDER=bedrock, BEDROCK_GUARDRAIL_ID (required); BEDROCK_GUARDRAIL_VERSION,
 *   BEDROCK_REGION (both optional, default 'DRAFT' / 'us-east-1').
 * Required env vars for the (permanently dead) legacy path, kept only for documentation:
 *   CONTENT_SAFETY_ENDPOINT, CONTENT_SAFETY_KEY
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { detectGroundedness, type GroundednessResult } from '../../safety/content-safety.js';
import { bedrockDetectGroundedness, isBedrockGuardrailConfigured } from '../../safety/bedrock-guardrails.js';

/**
 * The result shape either provider returns. `ran`/`error` are OPTIONAL so the legacy
 * content-safety.ts `GroundednessResult` (which predates them and never sets them) remains a
 * valid `GroundednessCheckResult` unchanged -- this is a pure widening, not a breaking change to
 * that type. Bedrock's bedrockDetectGroundedness() always sets `ran` explicitly (true on a real
 * call, false on "not selected" or a failed call).
 */
export interface GroundednessCheckResult extends GroundednessResult {
  /** True only when a provider actually attempted a live call. Present for the Bedrock path;
   *  absent (undefined) for the legacy Azure-retired NOT-RUN path, which has no notion of
   *  "attempted but failed" distinct from "never configured". */
  ran?: boolean;
  /** Present only when a configured provider was called and the call itself failed (network /
   *  non-2xx / malformed response). Never set alongside a real fully-grounded/ungrounded verdict. */
  error?: string;
}

/**
 * Pure summary builder, extracted (2026-08-28) so the "did a check actually run" fake-pass bug is
 * unit-testable without any MCP server scaffolding. `configured:false` is reported as an explicit
 * NOT RUN, never as "fully grounded": ungroundedDetected is meaningless when no check happened. A
 * configured provider that failed its call (`error` set) is reported as an explicit ERROR,
 * likewise never as "fully grounded" -- a failed call is not a verdict either. Only
 * `configured:true` with no `error` is a real check result. This is exactly the silent-failure
 * shape FND-20260821-e303 exists to close, now generalized to cover a live provider's own failure
 * mode, not only "never configured".
 */
export function summarizeGroundednessResult(result: GroundednessCheckResult): string {
  if (!result.configured) {
    return `Groundedness: NOT RUN — no content-safety provider (${result.provider}). This is not a check verdict.`;
  }
  if (result.error) {
    return `Groundedness: ERROR — the provider (${result.provider}) was called but failed: ${result.error}. This is not a check verdict.`;
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
          'Measures how much of the supplied text is unsupported by the provided grounding sources. Returns ungroundedDetected=true and an ungroundedPercentage when hallucinations are found. Provider is Amazon Bedrock Guardrails (Contextual Grounding check) when GUARDRAIL_PROVIDER=bedrock is configured; otherwise the legacy Azure AI Content Safety path (permanently RETIRED — Azure subscription deleted) reports an honest NOT RUN. A configured provider that fails its call reports an explicit ERROR. Neither state is ever rendered as a fake fully-grounded/ungrounded verdict; see `provider`/`ran`/`error`. Read-only; never mutates data.',
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
        ran: z.boolean().optional(),
        ungroundedDetected: z.boolean(),
        ungroundedPercentage: z.number(),
        provider: z.string(),
        error: z.string().optional(),
        raw: z.unknown(),
      },
      handler: async (input) => {
        const result: GroundednessCheckResult = isBedrockGuardrailConfigured()
          ? await bedrockDetectGroundedness(input.query, input.text, input.groundingSources)
          : await detectGroundedness(input.query, input.text, input.groundingSources);
        return { data: result, summary: summarizeGroundednessResult(result) };
      },
    },
    callerHash,
  );
}
