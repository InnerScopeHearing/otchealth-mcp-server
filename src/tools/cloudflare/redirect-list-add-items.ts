import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addRedirectListItems } from '../../cloudflare/full-client.js';

export function registerCloudflareRedirectListAddItems(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_redirect_list_add_items',
    category: 'write_orchestrated',
    annotations: {
      title: 'Add items to bulk redirect list',
      description: 'Add one or more source→target redirect entries to a bulk redirect list. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().describe('Cloudflare account ID.'),
      list_id: z.string().describe('Redirect list ID.'),
      items: z.array(z.object({
        source_url: z.string().describe('Source URL to redirect from.'),
        target_url: z.string().describe('Target URL to redirect to.'),
        status_code: z.number().int().optional().describe('HTTP status code (301, 302, 307, 308). Default 301.'),
        include_subdomains: z.boolean().optional().describe('Match subdomains of source_url.'),
        preserve_path_suffix: z.boolean().optional().describe('Append source path to target URL.'),
      })).min(1).describe('Redirect entries to add.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      result: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, result: null },
          audit: { before: null, after: { list_id: input.list_id, count: input.items.length } },
          summary: `DRY RUN: would add ${input.items.length} redirect(s) to list ${input.list_id}. Pass dry_run=false to apply.`,
        };
      }
      const items = input.items.map(i => ({ redirect: { source_url: i.source_url, target_url: i.target_url, status_code: i.status_code, include_subdomains: i.include_subdomains, preserve_path_suffix: i.preserve_path_suffix } }));
      const result = await addRedirectListItems(input.account_id, input.list_id, items);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: { list_id: input.list_id, count: input.items.length } },
        summary: `Added ${input.items.length} redirect(s) to list ${input.list_id}.`,
      };
    },
  }, callerHash);
}
