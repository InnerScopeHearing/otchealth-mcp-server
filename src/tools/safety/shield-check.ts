/**
 * MCP tool: shield_check
 * Calls Azure AI Content Safety Prompt Shields to detect prompt-injection
 * and jailbreak attacks in user prompts and optionally provided documents.
 *
 * RETIRED PROVIDER (2026-08-28, FND-20260821-e303): src/safety/content-safety.ts's Azure Content
 * Safety call path is permanently disabled (Azure subscription 55c84f6b was deleted 2026-08-13).
 * shieldPrompt() now always returns configured:false / provider:"none (azure retired)" — this
 * tool surface stays wired, but its summary reports that honestly (NOT RUN) instead of the old
 * behavior, which reported "clean" for a scan that never happened (a fake pass; see
 * summarizeShieldResult below, and content-safety.ts's module doc comment for the full history).
 *
 * Required env vars (historical; read by src/safety/content-safety.ts, no longer consulted):
 *   CONTENT_SAFETY_ENDPOINT
 *   CONTENT_SAFETY_KEY
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shieldPrompt, type ShieldPromptResult } from '../../safety/content-safety.js';

/**
 * Pure summary builder, extracted (2026-08-28) so the "did a scan actually run" fake-pass bug is
 * unit-testable without any MCP server scaffolding. `configured:false` (today, always — the
 * provider is retired) is reported as an explicit NOT RUN, never as "clean": attackDetected is
 * meaningless when no scan happened, and reporting it as though it were a verdict is exactly the
 * silent-failure shape FND-20260821-e303 exists to close.
 */
export function summarizeShieldResult(result: ShieldPromptResult): string {
  if (!result.configured) {
    return `Prompt Shields: NOT RUN — no content-safety provider (${result.provider}). This is not a scan verdict.`;
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
          'Runs Azure AI Content Safety Prompt Shields against a user prompt (and optional documents) to detect prompt-injection and jailbreak attacks. Returns attackDetected=true when a threat is found. The provider is currently RETIRED (Azure subscription permanently deleted) — every call returns configured=false and a NOT RUN summary rather than a fake clean/attack verdict; see `provider`. Read-only; never mutates data.',
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
        attackDetected: z.boolean(),
        userPromptAttack: z.boolean(),
        documentsAttack: z.boolean(),
        provider: z.string(),
        raw: z.unknown(),
      },
      handler: async (input) => {
        const result = await shieldPrompt(input.prompt, input.documents);
        return { data: result, summary: summarizeShieldResult(result) };
      },
    },
    callerHash,
  );
}
