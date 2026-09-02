/**
 * MCP tool: shield_check
 * Detects prompt-injection and jailbreak attacks in a user prompt (and optionally provided
 * documents).
 *
 * PROVIDER (2026-08-29): Amazon Bedrock Guardrails is now a real, live provider behind this tool
 * (src/safety/bedrock-guardrails.ts), selected when GUARDRAIL_PROVIDER=bedrock and
 * BEDROCK_GUARDRAIL_ID are both set. When Bedrock is not selected, this tool falls through
 * BYTE-FOR-BYTE to the legacy path: src/safety/content-safety.ts's Azure AI Content Safety call
 * path stays PERMANENTLY RETIRED (2026-08-28, FND-20260821-e303 — Azure subscription 55c84f6b was
 * deleted 2026-08-13), so shieldPrompt() there always returns configured:false /
 * provider:"none (azure retired)". Either way, summarizeShieldResult below reports the true state
 * honestly: NOT RUN when no provider is configured, an explicit ERROR when a configured provider
 * was called but failed, or a real clean/attack verdict — never a fake pass (see
 * summarizeShieldResult's own doc comment, and content-safety.ts's module doc comment for the
 * original incident this all traces back to).
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
import { shieldPrompt, type ShieldPromptResult } from '../../safety/content-safety.js';
import { bedrockShieldPrompt, isBedrockGuardrailConfigured } from '../../safety/bedrock-guardrails.js';

/**
 * The result shape either provider returns. `ran`/`error` are OPTIONAL so the legacy
 * content-safety.ts `ShieldPromptResult` (which predates them and never sets them) remains a
 * valid `ShieldCheckResult` unchanged -- this is a pure widening, not a breaking change to that
 * type. Bedrock's bedrockShieldPrompt() always sets `ran` explicitly (true on a real call, false
 * on "not selected" or a failed call).
 */
export interface ShieldCheckResult extends ShieldPromptResult {
  /** True only when a provider actually attempted a live call. Present for the Bedrock path;
   *  absent (undefined) for the legacy Azure-retired NOT-RUN path, which has no notion of
   *  "attempted but failed" distinct from "never configured". */
  ran?: boolean;
  /** Present only when a configured provider was called and the call itself failed (network /
   *  non-2xx / malformed response). Never set alongside a real clean/attack verdict. */
  error?: string;
}

/**
 * Pure summary builder, extracted (2026-08-28) so the "did a scan actually run" fake-pass bug is
 * unit-testable without any MCP server scaffolding. `configured:false` is reported as an explicit
 * NOT RUN, never as "clean": attackDetected is meaningless when no scan happened. A configured
 * provider that failed its call (`error` set) is reported as an explicit ERROR, likewise never as
 * "clean" -- a failed call is not a verdict either. Only `configured:true` with no `error` is a
 * real scan result. This is exactly the silent-failure shape FND-20260821-e303 exists to close,
 * now generalized to cover a live provider's own failure mode, not only "never configured".
 */
export function summarizeShieldResult(result: ShieldCheckResult): string {
  if (!result.configured) {
    return `Prompt Shields: NOT RUN — no content-safety provider (${result.provider}). This is not a scan verdict.`;
  }
  if (result.error) {
    return `Prompt Shields: ERROR — the provider (${result.provider}) was called but failed: ${result.error}. This is not a scan verdict.`;
  }
  return result.attackDetected ? 'Prompt Shields: attack DETECTED' : 'Prompt Shields: clean';
}

export function registerShieldCheck(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shield_check',
      category: 'read',
      annotations: {
        title: 'Prompt Shields — injection & jailbreak detection',
        description:
          'Detects prompt-injection and jailbreak attacks in a user prompt (and optional documents). Returns attackDetected=true when a threat is found. Provider is Amazon Bedrock Guardrails when GUARDRAIL_PROVIDER=bedrock is configured; otherwise the legacy Azure AI Content Safety path (permanently RETIRED — Azure subscription deleted) reports an honest NOT RUN. A configured provider that fails its call reports an explicit ERROR. Neither state is ever rendered as a fake clean/attack verdict; see `provider`/`ran`/`error`. Read-only; never mutates data.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        prompt: z.string().describe('The user prompt text to scan for injection / jailbreak attacks.'),
        documents: z
          .array(z.string())
          .optional()
          .describe('Optional grounding documents to scan for indirect injection attacks.'),
      },
      outputShape: {
        configured: z.boolean(),
        ran: z.boolean().optional(),
        attackDetected: z.boolean(),
        userPromptAttack: z.boolean(),
        documentsAttack: z.boolean(),
        provider: z.string(),
        error: z.string().optional(),
        raw: z.unknown(),
      },
      handler: async (input) => {
        const result: ShieldCheckResult = isBedrockGuardrailConfigured()
          ? await bedrockShieldPrompt(input.prompt, input.documents)
          : await shieldPrompt(input.prompt, input.documents);
        return { data: result, summary: summarizeShieldResult(result) };
      },
    },
    callerHash,
  );
}
