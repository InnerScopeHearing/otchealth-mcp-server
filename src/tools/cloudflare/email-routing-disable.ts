import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { disableEmailRouting } from '../../cloudflare/full-client.js';

export function registerCloudflareEmailRoutingDisable(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_email_routing_disable',
    category: 'write_orchestrated',
    annotations: {
      title: 'Disable email routing',
      description: 'Disable Cloudflare Email Routing for the zone. All email routing rules stop immediately. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
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
          audit: { before: null, after: { zone_id: input.zone_id ?? 'env:CLOUDFLARE_ZONE_ID' } },
          summary: 'DRY RUN: would DISABLE Email Routing — all forwarding rules will stop. Pass dry_run=false to apply.',
        };
      }
      const result = await disableEmailRouting(input.zone_id);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: { zone_id: input.zone_id } },
        summary: 'Email Routing disabled.',
      };
    },
  }, callerHash);
}
