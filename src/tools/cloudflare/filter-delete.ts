import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteFilter } from '../../cloudflare/full-client.js';

export function registerCloudflareFilterDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_filter_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete firewall filter',
      description: 'Permanently delete a legacy firewall filter. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      filter_id: z.string().describe('Filter ID to delete.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_filter_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_filter_id: input.filter_id },
          audit: { before: { filter_id: input.filter_id }, after: null },
          summary: `DRY RUN: would delete filter ${input.filter_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteFilter(input.filter_id, input.zone_id);
      return {
        data: { executed: true, dry_run: false, deleted_filter_id: input.filter_id },
        audit: { before: { filter_id: input.filter_id }, after: null },
        summary: `Deleted filter ${input.filter_id}.`,
      };
    },
  }, callerHash);
}
