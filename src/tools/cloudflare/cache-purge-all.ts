import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { purgeEverything } from '../../cloudflare/full-client.js';

export function registerCloudflareCachePurgeAll(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_cache_purge_all',
    category: 'write_orchestrated',
    annotations: {
      title: 'Purge entire Cloudflare cache',
      description: 'Purge ALL cached assets for a zone. This causes a traffic spike as origin re-fetches. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
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
          summary: 'DRY RUN: would purge ALL cached assets for the zone. Pass dry_run=false to apply.',
        };
      }
      const result = await purgeEverything(input.zone_id);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: { zone_id: input.zone_id ?? 'env:CLOUDFLARE_ZONE_ID' } },
        summary: 'Purged entire cache for the zone.',
      };
    },
  }, callerHash);
}
