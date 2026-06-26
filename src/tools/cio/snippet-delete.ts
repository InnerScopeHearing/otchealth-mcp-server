import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteSnippet } from '../../customerio/full-client.js';

export function registerCioSnippetDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_snippet_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Customer.io snippet',
      description: 'Permanently delete a Liquid snippet via App API DELETE /snippets/{id}. Irreversible — templates referencing this snippet will break. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      snippet_id: z.number().int().positive().describe('Numeric ID of the snippet to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      snippet_id: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, snippet_id: input.snippet_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete snippet ${input.snippet_id}. Pass dry_run=false to confirm.`,
        };
      }
      await deleteSnippet({ snippet_id: input.snippet_id, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, snippet_id: input.snippet_id },
        audit: { before: { snippet_id: input.snippet_id }, after: null },
        summary: `Snippet ${input.snippet_id} deleted.`,
      };
    },
  }, callerHash);
}
