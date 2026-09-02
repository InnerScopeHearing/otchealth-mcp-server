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
 *
 * PII (2026-09-02): the Bedrock path also surfaces `piiDetected`/`piiEntityTypes` -- see
 * bedrock-guardrails.ts's PII doc-comment section. This is independent of `attackDetected` (a
 * prompt can carry PII without being an injection attempt); see `scripts/create-guardrail.mjs` for
 * how the live guardrail's PII entity list is configured and versioned.
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
  /** True when the Bedrock path's SAME call also found sensitive PII. Present (true or false) for
   *  the Bedrock path; absent (undefined) for the legacy Azure-retired path, which never checked
   *  PII at all. See bedrock-guardrails.ts's PII doc-comment section. */
  piiDetected?: boolean;
  /** PII entity TYPES only (never the matched value); see BedrockShieldResult's own doc comment. */
  piiEntityTypes?: string[];
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
  const attackPart = result.attackDetected ? 'Prompt Shields: attack DETECTED' : 'Prompt Shields: clean';
  // PII is an independent signal from attackDetected (see BedrockShieldResult's doc comment) --
  // appended rather than replacing the attack verdict, and only when the provider actually checked
  // for it (piiDetected is undefined, not false, on the legacy Azure-retired path).
  if (result.piiDetected === undefined) return attackPart;
  if (!result.piiDetected) return `${attackPart}; no PII detected`;
  const types = (result.piiEntityTypes ?? []).join(', ') || 'unspecified type';
  return `${attackPart}; PII DETECTED (${types})`;
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
          'Detects prompt-injection and jailbreak attacks in a user prompt (and optional documents). Returns attackDetected=true when a threat is found. On the Bedrock path also returns piiDetected/piiEntityTypes for sensitive PII found in the SAME scan (an independent signal from attackDetected). Provider is Amazon Bedrock Guardrails when GUARDRAIL_PROVIDER=bedrock is configured; otherwise the legacy Azure AI Content Safety path (permanently RETIRED, Azure subscription deleted) reports an honest NOT RUN. A configured provider that fails its call reports an explicit ERROR. Neither state is ever rendered as a fake clean/attack verdict; see `provider`/`ran`/`error`. Read-only; never mutates data.',
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
        piiDetected: z.boolean().optional(),
        piiEntityTypes: z.array(z.string()).optional(),
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
