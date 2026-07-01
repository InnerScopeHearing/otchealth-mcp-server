/**
 * MCP tool: groundedness_check
 * Calls Azure AI Content Safety Groundedness Detection to identify
 * ungrounded / hallucinated claims in model-generated text relative to
 * a set of supplied source documents.
 *
 * Required env vars (read by src/safety/content-safety.ts):
 *   CONTENT_SAFETY_ENDPOINT
 *   CONTENT_SAFETY_KEY
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { detectGroundedness } from '../../safety/content-safety.js';

export function registerGroundednessCheck(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'groundedness_check',
      category: 'read',
      annotations: {
        title: 'Groundedness Detection — hallucination scan',
        description:
          'Runs Azure AI Content Safety Groundedness Detection to measure how much of the supplied text is unsupported by the provided grounding sources. Returns ungroundedDetected=true and an ungroundedPercentage when hallucinations are found. Read-only; never mutates data.',
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
        ungroundedDetected: z.boolean(),
        ungroundedPercentage: z.number(),
        raw: z.unknown(),
      },
      handler: async (input) => {
        const result = await detectGroundedness(
          input.query,
          input.text,
          input.groundingSources,
        );
        const pct = (result.ungroundedPercentage * 100).toFixed(1);
        const summary = result.ungroundedDetected
          ? `Groundedness: ungrounded content DETECTED (${pct}% ungrounded)`
          : `Groundedness: fully grounded (${pct}% ungrounded)`;
        return { data: result, summary };
      },
    },
    callerHash,
  );
}
