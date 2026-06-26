import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { purgeByUrls } from '../../cloudflare/full-client.js';

export function registerCloudflareCachePurgeByUrl(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_cache_purge_by_url',
    category: 'write_orchestrated',
    annotations: {
      title: 'Purge Cloudflare cache by URL',
      description: 'Purge specific cached URLs (up to 30 per request). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      urls: z.array(z.string().url()).min(1).max(30).describe('List of fully-qualified URLs to purge (max 30).'),
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
          audit: { before: null, after: { urls: input.urls } },
          summary: `DRY RUN: would purge ${input.urls.length} URL(s). Pass dry_run=false to apply.`,
        };
      }
      const result = await purgeByUrls(input.urls, input.zone_id);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: { urls: input.urls } },
        summary: `Purged ${input.urls.length} URL(s) from cache.`,
      };
    },
  }, callerHash);
}
