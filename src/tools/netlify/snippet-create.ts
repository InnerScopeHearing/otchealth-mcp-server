import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSnippet } from '../../netlify/full-client.js';

export function registerNetlifySnippetCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_snippet_create',
    category: 'write_simple',
    annotations: {
      title: 'Netlify: create site snippet',
      description: 'Inject an HTML snippet into all pages of a site (POST /sites/{site_id}/snippets). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      title: z.string().min(1).describe('Human-readable label for the snippet.'),
      general: z.string().optional().describe('HTML to inject on all pages.'),
      general_position: z.string().optional().describe('Where to inject: "head" or "footer".'),
      goal: z.string().optional().describe('HTML to inject on goal/conversion pages.'),
      goal_position: z.string().optional().describe('Where to inject goal HTML: "head" or "footer".'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.number().optional(),
      title: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const { site_id, ...snippet } = input;
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create snippet "${snippet.title}" for site ${site_id}. Pass dry_run=false to apply.`,
        };
      }
      const s = await createSnippet(site_id, snippet as any);
      return {
        data: { executed: true, dry_run: false, id: s.id, title: s.title },
        audit: { before: null, after: s },
        summary: `Created snippet "${s.title}" (id: ${s.id}) for site ${site_id}.`,
      };
    },
  }, callerHash);
}
