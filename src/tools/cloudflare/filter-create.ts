import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createFilter } from '../../cloudflare/full-client.js';

export function registerCloudflareFilterCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_filter_create',
    category: 'write_simple',
    annotations: {
      title: 'Create firewall filter',
      description: 'Create a legacy firewall filter expression (used by firewall rules). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      expression: z.string().describe('Wireshark-style filter expression.'),
      description: z.string().optional().describe('Human-readable description.'),
      paused: z.boolean().optional().describe('Start the filter paused (default false).'),
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
          audit: { before: null, after: { expression: input.expression } },
          summary: `DRY RUN: would create filter for expression "${input.expression}". Pass dry_run=false to apply.`,
        };
      }
      const filter = await createFilter(input.expression, input.description, input.paused, input.zone_id);
      return {
        data: { executed: true, dry_run: false, filter },
        audit: { before: null, after: input },
        summary: `Created filter: ${(filter as any)?.id}`,
      };
    },
  }, callerHash);
}
