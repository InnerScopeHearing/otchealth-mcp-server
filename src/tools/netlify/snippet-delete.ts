import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteSnippet } from '../../netlify/full-client.js';

export function registerNetlifySnippetDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_snippet_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete site snippet',
      description: 'Delete a site snippet (DELETE /sites/{site_id}/snippets/{snippet_id}). Immediately removes injected HTML. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      snippet_id: z.string().min(1).describe('Snippet ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      snippet_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, snippet_id: input.snippet_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete snippet ${input.snippet_id} from site ${input.site_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteSnippet(input.site_id, input.snippet_id);
      return {
        data: { executed: true, dry_run: false, snippet_id: input.snippet_id },
        audit: { before: { snippet_id: input.snippet_id }, after: null },
        summary: `Deleted snippet ${input.snippet_id} from site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
