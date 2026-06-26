import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteSite } from '../../netlify/full-client.js';

export function registerNetlifySiteDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_site_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete site',
      description: 'Permanently delete a Netlify site and all its deploys (DELETE /sites/{site_id}). IRREVERSIBLE. Requires CTO gate. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID to delete. Use netlify_list_sites to confirm.'),
      site_name_confirm: z.string().optional().describe('Paste the site name to double-confirm deletion intent.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      site_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, site_id: input.site_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently DELETE site ${input.site_id}. This is irreversible. Pass dry_run=false to apply.`,
        };
      }
      await deleteSite(input.site_id);
      return {
        data: { executed: true, dry_run: false, site_id: input.site_id },
        audit: { before: { site_id: input.site_id }, after: null },
        summary: `Deleted Netlify site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
