import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateFilter } from '../../cloudflare/full-client.js';

export function registerCloudflareFilterUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_filter_update',
    category: 'write_simple',
    annotations: {
      title: 'Update firewall filter',
      description: 'Replace a legacy firewall filter expression (PUT). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      filter_id: z.string().describe('Filter ID to update.'),
      expression: z.string().describe('New filter expression.'),
      description: z.string().optional().describe('New description.'),
      paused: z.boolean().optional().describe('Pause the filter.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      filter: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, filter: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update filter ${input.filter_id}. Pass dry_run=false to apply.`,
        };
      }
      const filter = await updateFilter(input.filter_id, input.expression, input.description, input.paused, input.zone_id);
      return {
        data: { executed: true, dry_run: false, filter },
        audit: { before: null, after: input },
        summary: `Updated filter ${input.filter_id}.`,
      };
    },
  }, callerHash);
}
