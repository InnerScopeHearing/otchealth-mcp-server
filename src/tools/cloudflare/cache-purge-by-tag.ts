import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { purgeByCacheTags } from '../../cloudflare/full-client.js';

export function registerCloudflareCachePurgeByTag(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_cache_purge_by_tag',
    category: 'write_orchestrated',
    annotations: {
      title: 'Purge Cloudflare cache by cache tag',
      description: 'Purge all cached assets matching one or more cache tags (requires Enterprise plan). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      tags: z.array(z.string()).min(1).max(30).describe('Cache tag(s) to purge (max 30).'),
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
          audit: { before: null, after: { tags: input.tags } },
          summary: `DRY RUN: would purge assets with tags [${input.tags.join(', ')}]. Pass dry_run=false to apply.`,
        };
      }
      const result = await purgeByCacheTags(input.tags, input.zone_id);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: { tags: input.tags } },
        summary: `Purged cache for ${input.tags.length} tag(s).`,
      };
    },
  }, callerHash);
}
