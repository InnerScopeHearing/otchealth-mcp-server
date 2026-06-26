import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateSnippet } from '../../netlify/full-client.js';

export function registerNetlifySnippetUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_snippet_update',
    category: 'write_simple',
    annotations: {
      title: 'Netlify: update site snippet',
      description: 'Replace an existing snippet\'s HTML or title (PUT /sites/{site_id}/snippets/{snippet_id}). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      snippet_id: z.string().min(1).describe('Snippet ID to update.'),
      title: z.string().optional().describe('New title.'),
      general: z.string().optional().describe('New HTML for all pages.'),
      general_position: z.string().optional().describe('"head" or "footer".'),
      goal: z.string().optional().describe('New HTML for goal pages.'),
      goal_position: z.string().optional().describe('"head" or "footer".'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.number().optional(),
      title: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const { site_id, snippet_id, ...patch } = input;
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update snippet ${snippet_id} for site ${site_id}. Pass dry_run=false to apply.`,
        };
      }
      const s = await updateSnippet(site_id, snippet_id, patch);
      return {
        data: { executed: true, dry_run: false, id: s.id, title: s.title },
        audit: { before: null, after: s },
        summary: `Updated snippet ${s.id ?? snippet_id} for site ${site_id}.`,
      };
    },
  }, callerHash);
}
