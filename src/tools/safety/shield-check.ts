/**
 * MCP tool: shield_check
 * Calls Azure AI Content Safety Prompt Shields to detect prompt-injection
 * and jailbreak attacks in user prompts and optionally provided documents.
 *
 * Required env vars (read by src/safety/content-safety.ts):
 *   CONTENT_SAFETY_ENDPOINT
 *   CONTENT_SAFETY_KEY
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shieldPrompt } from '../../safety/content-safety.js';

export function registerShieldCheck(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shield_check',
      category: 'read',
      annotations: {
        title: 'Prompt Shields — injection & jailbreak detection',
        description:
          'Runs Azure AI Content Safety Prompt Shields against a user prompt (and optional documents) to detect prompt-injection and jailbreak attacks. Returns attackDetected=true when a threat is found. Read-only; never mutates data.',
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
        attackDetected: z.boolean(),
        userPromptAttack: z.boolean(),
        documentsAttack: z.boolean(),
        raw: z.unknown(),
      },
      handler: async (input) => {
        const result = await shieldPrompt(input.prompt, input.documents);
        const summary = result.attackDetected
          ? 'Prompt Shields: attack DETECTED'
          : 'Prompt Shields: clean';
        return { data: result, summary };
      },
    },
    callerHash,
  );
}
