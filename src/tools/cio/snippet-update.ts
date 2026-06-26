import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateSnippet } from '../../customerio/full-client.js';

export function registerCioSnippetUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_snippet_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a Customer.io snippet',
      description: 'Update the name or content of a Liquid snippet via App API PUT /snippets/{id}. Changes propagate immediately to all templates referencing this snippet. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      snippet_id: z.number().int().positive().describe('Numeric ID of the snippet to update.'),
      name: z.string().min(1).optional().describe('New name for the snippet.'),
      value: z.string().optional().describe('New Liquid/HTML content for the snippet.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      snippet: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, snippet: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update snippet ${input.snippet_id}. Pass dry_run=false to apply.`,
        };
      }
      const snippet = await updateSnippet({ ...input, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, snippet },
        audit: { before: null, after: input },
        summary: `Snippet ${input.snippet_id} updated.`,
      };
    },
  }, callerHash);
}
